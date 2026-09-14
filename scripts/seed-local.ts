/** Add repeatable demo data without overwriting existing artifacts or edits. */
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';

import { eq } from 'drizzle-orm';

import { describeTextAnchor } from '../src/anchoring/text.js';
import { loadConfig } from '../src/server/config.js';
import { openDb, type DB } from '../src/server/db/index.js';
import { comments, documentCollaborators, documents, projects, teamMembers, teams, users, versions, type User } from '../src/server/db/schema.js';
import { indexVersionHtml, recomputeForVersion } from '../src/server/services/anchorStates.js';
import { renderMarkdownArtifact } from '../src/server/services/markdown.js';
import { normalizeProjectName } from '../src/server/services/projects.js';

const prefix = 'demo-projects-';
const id = (key: string) => `${prefix}${key}`;
const hour = 60 * 60 * 1000;

const people = {
  alex: { email: 'alex@example.test', name: 'Alex Morgan' },
  maya: { email: 'maya@example.test', name: 'Maya Chen' },
  sam: { email: 'sam@example.test', name: 'Sam Rivera' },
  riley: { email: 'riley@example.test', name: 'Riley Park' },
};
type Person = keyof typeof people;
type Team = 'studio' | 'customer';

const projectSpecs: { key: string; team: Team; name: string }[] = [
  { key: 'website', team: 'studio', name: 'Website launch' },
  { key: 'design', team: 'studio', name: 'Design system' },
  { key: 'mobile', team: 'studio', name: 'Mobile onboarding' },
  { key: 'research', team: 'studio', name: 'Research & discovery' },
  { key: 'ideas', team: 'studio', name: 'Future ideas' },
  { key: 'leadership', team: 'studio', name: 'Leadership planning' },
  { key: 'onboarding', team: 'customer', name: 'Customer onboarding' },
  { key: 'customer-research', team: 'customer', name: 'Research & discovery' },
  { key: 'partners', team: 'customer', name: 'Partner integrations and customer migration — Q4 rollout' },
];

interface ArtifactSpec {
  key: string;
  title: string;
  project?: string;
  team: Team;
  owner: Person;
  visibility?: 'team' | 'public' | 'private';
  guestRole?: 'viewer' | 'editor';
}
const artifactSpecs: ArtifactSpec[] = [
  { key: 'launch-brief', title: 'Website launch brief', project: 'website', team: 'studio', owner: 'alex', visibility: 'public' },
  { key: 'homepage', title: 'Homepage messaging and layout', project: 'website', team: 'studio', owner: 'maya' },
  { key: 'launch-checklist', title: 'Launch readiness checklist', project: 'website', team: 'studio', owner: 'sam' },
  { key: 'launch-budget', title: 'Launch budget — working notes', project: 'website', team: 'studio', owner: 'maya', visibility: 'private' },
  { key: 'tokens', title: 'Color, spacing, and typography tokens', project: 'design', team: 'studio', owner: 'maya' },
  { key: 'components', title: 'Component inventory', project: 'design', team: 'studio', owner: 'sam' },
  { key: 'accessibility', title: 'Accessibility review', project: 'design', team: 'studio', owner: 'alex' },
  { key: 'mobile-flow', title: 'First-run experience', project: 'mobile', team: 'studio', owner: 'maya' },
  { key: 'mobile-copy', title: 'Welcome screens and empty-state copy', project: 'mobile', team: 'studio', owner: 'alex' },
  { key: 'mobile-handoff', title: 'Mobile prototype — partner handoff', project: 'mobile', team: 'studio', owner: 'maya', visibility: 'private', guestRole: 'editor' },
  { key: 'interviews', title: 'Customer interview synthesis', project: 'research', team: 'studio', owner: 'sam' },
  { key: 'usability', title: 'Usability study: finding and organizing artifacts', project: 'research', team: 'studio', owner: 'maya' },
  { key: 'hiring', title: 'Hiring scenarios', project: 'leadership', team: 'studio', owner: 'maya', visibility: 'private' },
  { key: 'forecast', title: 'Capacity forecast', project: 'leadership', team: 'studio', owner: 'maya', visibility: 'private' },
  { key: 'welcome', title: 'Customer welcome guide', project: 'onboarding', team: 'customer', owner: 'sam', visibility: 'public' },
  { key: 'success-plan', title: 'First 30 days: customer success plan', project: 'onboarding', team: 'customer', owner: 'maya' },
  { key: 'handoff', title: 'Sales-to-success handoff', project: 'onboarding', team: 'customer', owner: 'sam' },
  { key: 'feedback', title: 'September feedback themes', project: 'customer-research', team: 'customer', owner: 'maya' },
  { key: 'advisory', title: 'Customer advisory notes', project: 'customer-research', team: 'customer', owner: 'sam', visibility: 'private', guestRole: 'viewer' },
  { key: 'migration', title: 'Partner migration plan and integration acceptance criteria', project: 'partners', team: 'customer', owner: 'sam' },
  { key: 'weekly', title: 'Weekly product update', team: 'studio', owner: 'alex' },
  { key: 'sketches', title: 'Early navigation sketches', team: 'studio', owner: 'maya' },
  { key: 'support', title: 'Support playbook draft', team: 'customer', owner: 'sam' },
];

export function seedLocal(db: DB, viewerEmail?: string) {
  const now = new Date();
  const ago = (hours: number) => new Date(now.getTime() - hours * hour);

  return db.transaction((tx) => {
    const ensureUser = (key: string, email: string, name?: string): User => {
      const existing = tx.select().from(users).where(eq(users.email, email)).get();
      if (existing) return existing;
      return tx.insert(users).values({ id: id(key), email, name, createdAt: ago(24 * 30) }).returning().get();
    };
    const actors = Object.fromEntries(Object.entries(people).map(([key, person]) => [key, ensureUser(key, person.email, person.name)])) as Record<Person, User>;
    const viewer = viewerEmail ? ensureUser('local-viewer', viewerEmail.trim().toLowerCase()) : actors.alex;

    for (const [key, name] of [['studio', 'Demo · Product Studio'], ['customer', 'Demo · Customer Experience']] as const) {
      tx.insert(teams).values({ id: id(key), name, createdAt: ago(24 * 30) }).onConflictDoNothing().run();
      const members = key === 'studio' ? [actors.alex, actors.maya, actors.sam, viewer] : [actors.maya, actors.sam, viewer];
      for (const member of members) {
        tx.insert(teamMembers).values({
          teamId: id(key), userId: member.id, role: member.id === viewer.id || member.id === actors.alex.id || member.id === actors.sam.id ? 'admin' : 'member', createdAt: ago(24 * 30),
        }).onConflictDoNothing().run();
      }
    }
    for (const project of projectSpecs) {
      tx.insert(projects).values({
        id: id(project.key), teamId: id(project.team), ...normalizeProjectName(project.name),
        createdBy: actors.maya.id, createdAt: ago(24 * 21), updatedAt: ago(24 * 21),
      }).onConflictDoNothing().run();
    }

    let addedArtifacts = 0;
    for (const [index, spec] of artifactSpecs.entries()) {
      const documentId = id(spec.key);
      // Skip the entire artifact on reruns, preserving moves, revisions, and comments.
      if (tx.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).get()) continue;
      const owner = actors[spec.owner];
      const versionCount = 1 + index % 3;
      const publishedAt = ago(2 + index * 7);
      const createdAt = new Date(publishedAt.getTime() - (versionCount - 1) * 24 * hour);
      tx.insert(documents).values({
        id: documentId, title: spec.title, teamId: id(spec.team), projectId: spec.project ? id(spec.project) : null,
        createdBy: owner.id, visibility: spec.visibility ?? 'team', createdAt,
      }).run();

      const versionIds: string[] = [];
      const quotes = ['Make the next step clear.', 'Review the draft with the project team.', 'Capture decisions before the next milestone.'];
      for (let number = 1; number <= versionCount; number++) {
        const versionId = id(`${spec.key}-v${number}`);
        const markdown = [
          `# ${spec.title}`, '', `Prepared by **${owner.name}** · Revision ${number}`, '',
          '## Overview', '', `This example explores ${spec.title.toLowerCase()} for the ${spec.team === 'studio' ? 'product studio' : 'customer experience'} team.`, '',
          `The current proposal has ${number === 1 ? 'an initial scope ready for feedback' : number === 2 ? 'a refined scope and assigned owners' : 'an agreed scope, assigned owners, and acceptance criteria'}.`, '',
          '## Review goals', '', ...quotes.map((quote) => `- ${quote}`), '',
          '## Milestones', '', '| Milestone | Owner | Status |', '| --- | --- | --- |',
          `| Draft | ${owner.name} | Complete |`, `| Team review | ${spec.team === 'studio' ? 'Maya Chen' : 'Sam Rivera'} | ${number === 1 ? 'Planned' : 'In progress'} |`,
          `| Final handoff | ${owner.name} | ${number === 3 ? 'Ready' : 'Planned'} |`, '',
          '## Next steps', '', 'Confirm the scope and leave feedback on the review goals above.',
        ].join('\n');
        tx.insert(versions).values({
          id: versionId, documentId, number, html: renderMarkdownArtifact(markdown, spec.title), sourceMarkdown: markdown,
          publishedBy: owner.id, publishedAt: new Date(createdAt.getTime() + (number - 1) * 24 * hour),
        }).run();
        versionIds.push(versionId);
      }
      tx.update(documents).set({ currentVersionId: versionIds.at(-1)! }).where(eq(documents.id, documentId)).run();
      if (spec.guestRole) {
        for (const collaborator of [actors.riley, viewer]) {
          if (collaborator.id === owner.id) continue;
          tx.insert(documentCollaborators).values({
            documentId, userId: collaborator.id, role: spec.guestRole, grantedBy: owner.id, createdAt, updatedAt: createdAt,
          }).onConflictDoNothing().run();
        }
      }

      const firstVersion = tx.select().from(versions).where(eq(versions.id, versionIds[0])).get()!;
      const text = indexVersionHtml(firstVersion.html);
      for (let thread = 0; thread < index % 4; thread++) {
        const quote = quotes[thread];
        const start = text.indexOf(quote);
        if (start === -1) throw new Error(`Missing seed comment quote in ${spec.key}`);
        const resolved = thread === 2;
        tx.insert(comments).values({
          id: id(`${spec.key}-comment-${thread}`), documentId, authorId: spec.visibility === 'private' ? owner.id : actors.sam.id,
          body: ['Can we make this concrete with an example?', 'Looks good. Let’s include a review with the team before handoff.', 'Decision captured in the latest draft.'][thread],
          quotedText: quote, anchor: JSON.stringify(describeTextAnchor(text, start, start + quote.length)),
          status: resolved ? 'resolved' : 'open', createdVersionId: firstVersion.id,
          createdAt: new Date(createdAt.getTime() + (thread + 1) * 60_000),
          resolvedAt: resolved ? new Date(publishedAt.getTime() + 5 * 60_000) : null, resolvedBy: resolved ? owner.id : null,
        }).run();
      }
      for (const versionId of versionIds) recomputeForVersion(tx, documentId, versionId);
      addedArtifacts++;
    }
    return { addedArtifacts, viewerEmail: viewer.email, teamCount: 2, projectCount: projectSpecs.length, artifactCount: artifactSpecs.length };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync('.env')) loadEnvFile('.env');
  if (process.env.NODE_ENV === 'production') throw new Error('This seed is for local development only.');
  const config = loadConfig();
  const { db, sqlite } = openDb(config.databasePath);
  try {
    const result = seedLocal(db, process.env.SEED_USER_EMAIL || config.instanceAdminEmails[0]);
    console.log(`Seeded ${config.databasePath}: ${result.addedArtifacts} new artifacts (${result.artifactCount} examples across ${result.projectCount} projects and ${result.teamCount} teams).`);
    console.log(`Refresh the local app as ${result.viewerEmail}.`);
    console.log(`Demo sign-ins: ${Object.values(people).map((person) => person.email).join(', ')}`);
    console.log('Use the local DEV_LOGIN_CODE, or the code recorded in DEV_LOGIN_CODE_FILE.');
  } finally {
    sqlite.close();
  }
}
