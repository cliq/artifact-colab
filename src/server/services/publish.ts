/**
 * Shared publish flow behind both the MCP publish_artifact tool and the REST
 * POST /api/publish endpoint: validates sizes and asset names, renders
 * Markdown submissions to HTML (keeping the source on the version), creates
 * the document (or appends a version to an existing one), upserts assets
 * (claiming any staged uploads), and recomputes comment anchors.
 */

import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { DB, DBOrTx } from '../db/index.js';
import { documents, projects, versions, teamMembers, type User } from '../db/schema.js';
import { resolveDocumentAccess } from './access.js';
import { recomputeForVersion } from './anchorStates.js';
import { setDocumentVisibility, type DocumentVisibility } from './documents.js';
import { renderMarkdownArtifact } from './markdown.js';
import { ProjectError, resolveProjectForPublish } from './projects.js';
import { autoWatch } from './watches.js';
import {
  isValidAssetName,
  MAX_ASSET_BYTES,
  MAX_ASSETS_TOTAL_BYTES,
  upsertAssets,
  type IncomingAsset,
} from './assets.js';
import { claimUploads, readUploads } from './assetUploads.js';

export const MAX_HTML_BYTES = 5 * 1024 * 1024;

/** Base58 (no 0/O/I/l) — short, unambiguous, URL-safe document slugs. */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function slug(length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE58[bytes[i]! % BASE58.length];
  return out;
}

function id(): string {
  return randomBytes(8).toString('hex');
}

export interface PublishInput {
  title: string;
  /** Complete HTML for the artifact. Exactly one of `html` / `markdown` must be given. */
  html?: string;
  /** Markdown source; the server renders it to HTML at publish time and keeps the source on the version. */
  markdown?: string;
  documentId?: string;
  assets?: IncomingAsset[];
  /** Files staged through prepare_asset_upload by `tokenId`, added to `assets` and consumed once the version is written. */
  uploads?: { tokenId: string; ids: string[] };
  /** Sets it on create (default 'team'); on republish, updates it when given, keeps the current value when omitted. */
  visibility?: DocumentVisibility;
  /** Omitted preserves assignment; null clears it; a name resolves or creates a Project. */
  project?: string | null;
}

type BasePublishSuccess = { ok: true; documentId: string; versionNumber: number; url: string; orphaned: number };
export type PublishOutcome =
  | (BasePublishSuccess & { project: string | null; projectCreated: boolean })
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type DocumentVersionPublishOutcome =
  | BasePublishSuccess
  | { ok: false; status: 400 | 403 | 404; error: string };

/** Bearer publishing never leaves the token's team. */
export function publishArtifact(db: DB, config: Config, user: User, teamId: string, input: PublishInput): PublishOutcome {
  try {
    return db.transaction((tx) => publishWithin(tx, config, user, { kind: 'team', teamId }, input));
  } catch (error) {
    if (error instanceof ProjectError) return { ok: false, status: error.status, error: error.message };
    throw error;
  }
}

/** Session publishing targets an existing artifact and cannot alter its visibility or ownership. */
export function publishDocumentVersion(
  db: DB,
  config: Config,
  user: User,
  documentId: string,
  input: Omit<PublishInput, 'documentId' | 'visibility' | 'project' | 'uploads'>,
): DocumentVersionPublishOutcome {
  const outcome = db.transaction((tx) =>
    publishWithin(tx, config, user, { kind: 'document' }, { ...input, documentId, visibility: undefined, project: undefined }),
  );
  if (!outcome.ok) {
    return { ok: false, status: outcome.status === 409 ? 400 : outcome.status, error: outcome.error };
  }
  const { documentId: savedId, versionNumber, url, orphaned } = outcome;
  return { ok: true, documentId: savedId, versionNumber, url, orphaned };
}

function publishWithin(db: DBOrTx, config: Config, user: User, scope: { kind: 'team'; teamId: string } | { kind: 'document' }, input: PublishInput): PublishOutcome {
  const { title, markdown, documentId: existingId } = input;

  if (!title.trim() || title.length > 300) return { ok: false, status: 400, error: 'title is required (max 300 chars)' };
  if (scope.kind === 'team' && !db.select().from(teamMembers).where(and(eq(teamMembers.teamId, scope.teamId), eq(teamMembers.userId, user.id))).get()) {
    return { ok: false, status: 404, error: 'team membership required' };
  }
  if ((input.html === undefined) === (markdown === undefined)) {
    return { ok: false, status: 400, error: 'provide exactly one of html or markdown' };
  }
  const source = input.html ?? markdown!;
  if (source.length === 0) return { ok: false, status: 400, error: 'source is empty' };
  if (Buffer.byteLength(source, 'utf8') > MAX_HTML_BYTES) {
    return { ok: false, status: 400, error: `${input.html !== undefined ? 'html' : 'markdown'} exceeds the 5 MB cap` };
  }
  const html = input.html ?? renderMarkdownArtifact(markdown!, title);

  let incoming = input.assets ?? [];
  let claimed: string[] = [];
  if (input.uploads && input.uploads.ids.length > 0) {
    const staged = readUploads(db, input.uploads.tokenId, input.uploads.ids, new Date());
    if (!staged.ok) return { ok: false, status: 400, error: staged.error };
    const seen = new Set(incoming.map((a) => a.name));
    for (const asset of staged.assets) {
      if (seen.has(asset.name)) return { ok: false, status: 400, error: `asset ${asset.name} is given more than once` };
      seen.add(asset.name);
    }
    incoming = [...incoming, ...staged.assets];
    claimed = staged.idHashes;
  }
  let total = 0;
  for (const asset of incoming) {
    if (!isValidAssetName(asset.name)) {
      return { ok: false, status: 400, error: `invalid asset name: ${asset.name} (letters, digits, ./_- only, no "..")` };
    }
    if (asset.data.length === 0) return { ok: false, status: 400, error: `asset ${asset.name} is empty` };
    if (asset.data.length > MAX_ASSET_BYTES) {
      return { ok: false, status: 400, error: `asset ${asset.name} exceeds the 4 MB per-file cap` };
    }
    total += asset.data.length;
    if (total > MAX_ASSETS_TOTAL_BYTES) return { ok: false, status: 400, error: 'assets exceed the 20 MB total cap' };
  }

  const now = new Date();
  let docId: string;
  let versionNumber: number;
  let projectName: string | null = null;
  let projectCreated = false;
  let projectId: string | null | undefined;
  if (existingId !== undefined) {
    const access = resolveDocumentAccess(db, existingId, user.id);
    const doc = access?.document;
    if (!doc || (scope.kind === 'team' && doc.teamId !== scope.teamId)) return { ok: false, status: 404, error: `unknown document_id: ${existingId}` };
    if (!access?.canPublish) return { ok: false, status: 403, error: 'editor permission required' };
    if (input.visibility !== undefined && input.visibility !== doc.visibility && !access.canChangeVisibility) {
      return { ok: false, status: 403, error: 'only the owner can change private access' };
    }
    if (input.visibility === 'private' && doc.visibility !== 'private' && !access.isOwner) {
      return { ok: false, status: 403, error: 'only the creator of a document can make it private' };
    }
    if (scope.kind === 'team') {
      if (input.project === null) {
        projectId = null;
      } else if (input.project !== undefined) {
        const resolved = resolveProjectForPublish(db, scope.teamId, user.id, input.project);
        projectId = resolved.project.id;
        projectName = resolved.project.name;
        projectCreated = resolved.created;
      } else if (doc.projectId !== null) {
        projectName = db.select({ name: projects.name }).from(projects).where(eq(projects.id, doc.projectId)).get()?.name ?? null;
      }
    }
    docId = doc.id;
    const latest = db
      .select({ number: versions.number })
      .from(versions)
      .where(eq(versions.documentId, docId))
      .all()
      .reduce((max, v) => Math.max(max, v.number), 0);
    versionNumber = latest + 1;
    db.update(documents)
      .set({ title, ...(projectId !== undefined ? { projectId } : {}) })
      .where(eq(documents.id, docId))
      .run();
    if (input.visibility !== undefined && input.visibility !== doc.visibility) {
      // Through the shared flip path: reverting to team-only must prune outsiders' watches.
      setDocumentVisibility(db, doc, input.visibility);
    }
  } else {
    if (scope.kind !== 'team') return { ok: false, status: 400, error: 'document required' };
    const teamId = scope.teamId;
    if (input.project !== undefined && input.project !== null) {
      const resolved = resolveProjectForPublish(db, teamId, user.id, input.project);
      projectId = resolved.project.id;
      projectName = resolved.project.name;
      projectCreated = resolved.created;
    }
    docId = slug();
    versionNumber = 1;
    db.insert(documents)
      .values({
        id: docId,
        title,
        teamId,
        createdBy: user.id,
        visibility: input.visibility ?? 'team',
        projectId: projectId ?? null,
        currentVersionId: null,
        createdAt: now,
      })
      .run();
  }

  const versionId = id();
  db.insert(versions)
    .values({ id: versionId, documentId: docId, number: versionNumber, html, sourceMarkdown: markdown ?? null, publishedAt: now, publishedBy: user.id })
    .run();
  db.update(documents).set({ currentVersionId: versionId }).where(eq(documents.id, docId)).run();
  if (incoming.length > 0) upsertAssets(db, docId, incoming, now);
  // Only on success: an error returned above still commits the transaction.
  claimUploads(db, claimed);
  autoWatch(db, docId, user.id, now);
  const { orphaned } = recomputeForVersion(db, docId, versionId);

  return {
    ok: true,
    documentId: docId,
    versionNumber,
    url: `${config.baseUrl}/d/${docId}`,
    orphaned,
    project: projectName,
    projectCreated,
  };
}

/** One exact-text replacement in an artifact's stored source. */
export interface ArtifactEdit {
  oldStr: string;
  newStr: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replaceAll?: boolean;
}

export const MAX_EDITS_PER_CALL = 64;

export type EditArtifactOutcome =
  | (BasePublishSuccess & { project: string | null; baseVersion: number; format: 'html' | 'markdown' })
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length > 60 ? `${flat.slice(0, 57)}...` : flat);
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/**
 * Applies edits in order to `source`, each against the text left by the ones
 * before it. All or nothing: the first miss returns its error.
 */
export function applyArtifactEdits(
  source: string,
  edits: ArtifactEdit[],
  maxBytes = MAX_HTML_BYTES,
): { ok: true; text: string } | { ok: false; error: string } {
  let text = source;
  let bytes = Buffer.byteLength(source, 'utf8');
  for (const [index, edit] of edits.entries()) {
    const label = `edit ${index + 1} (old_str ${preview(edit.oldStr)})`;
    if (edit.oldStr.length === 0) return { ok: false, error: `edit ${index + 1}: old_str is empty` };
    const count = countOccurrences(text, edit.oldStr);
    if (count === 0) {
      return { ok: false, error: `${label} was not found${index > 0 ? ' after applying the edits before it' : ''}` };
    }
    if (count > 1 && !edit.replaceAll) {
      return { ok: false, error: `${label} occurs ${count} times; include more surrounding text to make it unique, or set replace_all` };
    }
    // Checked before allocating: chained replace_all edits can otherwise grow the text exponentially.
    const replaced = edit.replaceAll ? count : 1;
    const projected = bytes + replaced * (Buffer.byteLength(edit.newStr, 'utf8') - Buffer.byteLength(edit.oldStr, 'utf8'));
    if (projected > maxBytes) {
      return { ok: false, error: `edit ${index + 1} would grow the source past the ${maxBytes / (1024 * 1024)} MB cap` };
    }
    bytes = projected;
    if (edit.replaceAll) {
      text = text.split(edit.oldStr).join(edit.newStr);
    } else {
      const at = text.indexOf(edit.oldStr);
      text = text.slice(0, at) + edit.newStr + text.slice(at + edit.oldStr.length);
    }
  }
  return { ok: true, text };
}

/**
 * Publishes a new version of an existing artifact by applying exact-text edits
 * to its current version's stored source (the Markdown for Markdown-published
 * versions, so it stays Markdown), so an agent can revise an artifact without
 * holding the whole source. Assets are document-scoped and carry over as-is.
 * Access is checked before any edit is matched, so a miss never reveals
 * content to someone who could not publish.
 */
export function editArtifact(
  db: DB,
  config: Config,
  user: User,
  teamId: string,
  input: { documentId: string; edits: ArtifactEdit[]; expectedVersion?: number; title?: string },
): EditArtifactOutcome {
  if (input.edits.length === 0) return { ok: false, status: 400, error: 'provide at least one edit' };
  if (input.edits.length > MAX_EDITS_PER_CALL) return { ok: false, status: 400, error: `at most ${MAX_EDITS_PER_CALL} edits per call` };
  try {
    return db.transaction((tx): EditArtifactOutcome => {
      const access = resolveDocumentAccess(tx, input.documentId, user.id);
      const doc = access?.document;
      if (!access?.isMember || !doc || doc.teamId !== teamId) {
        return { ok: false, status: 404, error: `unknown document_id: ${input.documentId}` };
      }
      if (!access.canPublish) return { ok: false, status: 403, error: 'editor permission required' };
      const current = doc.currentVersionId ? tx.select().from(versions).where(eq(versions.id, doc.currentVersionId)).get() : undefined;
      if (!current) return { ok: false, status: 404, error: `document ${doc.id} has no published version` };
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.number) {
        return {
          ok: false,
          status: 409,
          error:
            `version ${current.number} is current, not ${input.expectedVersion}: someone published since you read it. ` +
            'Nothing was published. Fetch the current version with get_artifact, then redo the edits against it.',
        };
      }

      const format = current.sourceMarkdown !== null ? 'markdown' : 'html';
      const source = current.sourceMarkdown ?? current.html;
      const applied = applyArtifactEdits(source, input.edits);
      if (!applied.ok) {
        return {
          ok: false,
          status: 400,
          error: `${applied.error} in version ${current.number}'s ${format === 'markdown' ? 'Markdown' : 'HTML'}. Nothing was published.`,
        };
      }
      const renamed = input.title !== undefined && input.title !== doc.title;
      if (applied.text === source && !renamed) {
        return { ok: false, status: 400, error: 'the edits leave the source unchanged. Nothing was published.' };
      }

      const outcome = publishWithin(tx, config, user, { kind: 'team', teamId }, {
        title: input.title ?? doc.title,
        documentId: doc.id,
        ...(format === 'markdown' ? { markdown: applied.text } : { html: applied.text }),
      });
      if (!outcome.ok) return outcome;
      const { documentId, versionNumber, url, orphaned, project } = outcome;
      return { ok: true, documentId, versionNumber, url, orphaned, project, baseVersion: current.number, format };
    });
  } catch (error) {
    if (error instanceof ProjectError) return { ok: false, status: error.status, error: error.message };
    throw error;
  }
}
