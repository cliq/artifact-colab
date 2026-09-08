/**
 * Usage analytics for the instance-admin area: per-team document, version,
 * comment and storage totals plus the most recent activity, and instance-wide
 * totals for the /admin overview. Read-only; nothing here writes.
 *
 * "Last activity" is derived from what the app already records — publishes,
 * comments, and MCP token use. Plain page views are not tracked, so a team
 * that only reads never bumps it.
 */

import { count, eq, max, sql } from 'drizzle-orm';

import type { DB } from '../db/index.js';
import { assets, comments, documents, teams, tokens, users, versions } from '../db/schema.js';

export interface TeamStats {
  documents: number;
  publicDocuments: number;
  teamDocuments: number;
  privateDocuments: number;
  versions: number;
  comments: number;
  assets: number;
  /** Bytes of published HTML and Markdown source across all versions. */
  contentBytes: number;
  /** Bytes of uploaded asset blobs. */
  assetBytes: number;
  /** `contentBytes + assetBytes`. */
  storageBytes: number;
  lastPublishedAt: Date | null;
  lastCommentAt: Date | null;
  /** Most recent MCP request through one of the team's tokens. */
  lastAgentAccessAt: Date | null;
  /** Latest of the three timestamps above. */
  lastActivityAt: Date | null;
}

export interface InstanceStats {
  teams: number;
  users: number;
  documents: number;
  storageBytes: number;
  /** Size of the SQLite database file (pages × page size), including indexes and free pages. */
  databaseBytes: number;
}

/** Byte length of a TEXT column; `length()` on text counts characters, so cast to BLOB first. */
const textBytes = (column: unknown) => sql<number>`coalesce(length(cast(${column} as blob)), 0)`;

function toDate(ms: number | string | null | undefined): Date | null {
  if (ms === null || ms === undefined) return null;
  return new Date(Number(ms));
}

function latest(...dates: (Date | null)[]): Date | null {
  return dates.reduce<Date | null>((best, d) => (d && (!best || d > best) ? d : best), null);
}

export function teamStats(db: DB, teamId: string): TeamStats {
  const docs = db
    .select({
      total: count(),
      publicCount: sql<number>`sum(${documents.visibility} = 'public')`,
      teamCount: sql<number>`sum(${documents.visibility} = 'team')`,
      privateCount: sql<number>`sum(${documents.visibility} = 'private')`,
    })
    .from(documents)
    .where(eq(documents.teamId, teamId))
    .get();

  const versionRow = db
    .select({
      total: count(),
      bytes: sql<number>`coalesce(sum(${textBytes(versions.html)} + ${textBytes(versions.sourceMarkdown)}), 0)`,
      lastPublishedAt: max(versions.publishedAt),
    })
    .from(versions)
    .innerJoin(documents, eq(documents.id, versions.documentId))
    .where(eq(documents.teamId, teamId))
    .get();

  const commentRow = db
    .select({ total: count(), lastCommentAt: max(comments.createdAt) })
    .from(comments)
    .innerJoin(documents, eq(documents.id, comments.documentId))
    .where(eq(documents.teamId, teamId))
    .get();

  const assetRow = db
    .select({ total: count(), bytes: sql<number>`coalesce(sum(length(${assets.data})), 0)` })
    .from(assets)
    .innerJoin(documents, eq(documents.id, assets.documentId))
    .where(eq(documents.teamId, teamId))
    .get();

  const tokenRow = db.select({ lastUsedAt: max(tokens.lastUsedAt) }).from(tokens).where(eq(tokens.teamId, teamId)).get();

  const contentBytes = Number(versionRow?.bytes ?? 0);
  const assetBytes = Number(assetRow?.bytes ?? 0);
  const lastPublishedAt = toDate(versionRow?.lastPublishedAt as number | null);
  const lastCommentAt = toDate(commentRow?.lastCommentAt as number | null);
  const lastAgentAccessAt = toDate(tokenRow?.lastUsedAt as number | null);

  return {
    documents: docs?.total ?? 0,
    publicDocuments: Number(docs?.publicCount ?? 0),
    teamDocuments: Number(docs?.teamCount ?? 0),
    privateDocuments: Number(docs?.privateCount ?? 0),
    versions: versionRow?.total ?? 0,
    comments: commentRow?.total ?? 0,
    assets: assetRow?.total ?? 0,
    contentBytes,
    assetBytes,
    storageBytes: contentBytes + assetBytes,
    lastPublishedAt,
    lastCommentAt,
    lastAgentAccessAt,
    lastActivityAt: latest(lastPublishedAt, lastCommentAt, lastAgentAccessAt),
  };
}

export function instanceStats(db: DB): InstanceStats {
  const teamCount = db.select({ value: count() }).from(teams).get()?.value ?? 0;
  const userCount = db.select({ value: count() }).from(users).get()?.value ?? 0;
  const documentCount = db.select({ value: count() }).from(documents).get()?.value ?? 0;
  const contentBytes = db
    .select({ value: sql<number>`coalesce(sum(${textBytes(versions.html)} + ${textBytes(versions.sourceMarkdown)}), 0)` })
    .from(versions)
    .get()?.value;
  const assetBytes = db.select({ value: sql<number>`coalesce(sum(length(${assets.data})), 0)` }).from(assets).get()?.value;

  const pageCount = db.get<{ page_count: number }>(sql`pragma page_count`)?.page_count ?? 0;
  const pageSize = db.get<{ page_size: number }>(sql`pragma page_size`)?.page_size ?? 0;

  return {
    teams: teamCount,
    users: userCount,
    documents: documentCount,
    storageBytes: Number(contentBytes ?? 0) + Number(assetBytes ?? 0),
    databaseBytes: pageCount * pageSize,
  };
}

/** Human-readable size: "0 B", "12.4 KB", "3.1 MB". Decimal units, one decimal above bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit += 1;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}
