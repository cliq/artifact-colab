/**
 * Drizzle schema for the app's SQLite database. Every timestamp column is
 * stored as epoch milliseconds and mapped to/from `Date` via `mode:
 * 'timestamp_ms'`. Hashed secrets (login codes, session tokens, access
 * tokens) are never stored in plaintext — only their hash is a column here.
 */

import { AnySQLiteColumn, blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  /** Display name from the profile page; null until the user fills it in (email is shown instead). */
  name: text('name'),
  /**
   * Admins promoted from the UI. Effective instance-admin status is this OR
   * membership in `INSTANCE_ADMIN_EMAILS` (the env list is the recovery path
   * and cannot be demoted).
   */
  isInstanceAdmin: integer('is_instance_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

export const teamMembers = sqliteTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** 'member' | 'admin'. Team admins manage people; commenting/publishing is role-independent. */
    role: text('role').notNull().default('member'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })],
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;

/**
 * Sticky removal tombstones: domain auto-join skips excluded users, so
 * removing a member whose domain is attached to the team doesn't silently
 * undo itself on their next sign-in. An explicit invite/re-add clears the row.
 */
export const teamExclusions = sqliteTable(
  'team_exclusions',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })],
);

export type TeamExclusion = typeof teamExclusions.$inferSelect;
export type NewTeamExclusion = typeof teamExclusions.$inferInsert;

export const teamDomains = sqliteTable('team_domains', {
  /** Lowercased. Being the primary key guarantees a domain auto-joins exactly one team. */
  domain: text('domain').primaryKey(),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type TeamDomain = typeof teamDomains.$inferSelect;
export type NewTeamDomain = typeof teamDomains.$inferInsert;

export const teamInvites = sqliteTable(
  'team_invites',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    /** Lowercased. Redeemed (converted to membership) on the invitee's next sign-in. */
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [uniqueIndex('team_invites_team_id_email_idx').on(table.teamId, table.email)],
);

export type TeamInvite = typeof teamInvites.$inferSelect;
export type NewTeamInvite = typeof teamInvites.$inferInsert;

export const loginCodes = sqliteTable(
  'login_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('login_codes_email_idx').on(table.email)],
);

export type LoginCode = typeof loginCodes.$inferSelect;
export type NewLoginCode = typeof loginCodes.$inferInsert;

export const sessions = sqliteTable('sessions', {
  /** SHA-256 hash of the session token; the raw token only ever lives in the cookie. */
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  /** Tokens are team-scoped: publishes through this token land in this team. */
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id),
  tokenHash: text('token_hash').notNull().unique(),
  label: text('label').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
});

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;

export const documents = sqliteTable(
  'documents',
  {
    /** Short URL slug. */
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    /**
     * 'team' | 'public'. 'public' widens read/interact access to any signed-in
     * user who has the URL — the slug is the link secret; the document is
     * never listed for non-members. Ownership stays with `teamId`.
     */
    visibility: text('visibility').notNull().default('team'),
    /** No FK to `versions.id` to avoid a circular reference between the two tables. */
    currentVersionId: text('current_version_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('documents_team_id_idx').on(table.teamId)],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    /** The exact string the artifact HTML uses in src attributes. */
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    data: blob('data', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('assets_document_id_idx').on(table.documentId),
    uniqueIndex('assets_document_id_name_idx').on(table.documentId, table.name),
  ],
);

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;

export const versions = sqliteTable(
  'versions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    number: integer('number').notNull(),
    html: text('html').notNull(),
    /**
     * When the version was published as Markdown, the original source; `html`
     * then holds the server-side render. Null for versions published as HTML.
     */
    sourceMarkdown: text('source_markdown'),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('versions_document_id_idx').on(table.documentId),
    uniqueIndex('versions_document_id_number_unique').on(table.documentId, table.number),
  ],
);

export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    /** Self-reference for threading; declared as a lazy callback to avoid TS circularity. */
    parentId: text('parent_id').references((): AnySQLiteColumn => comments.id),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    quotedText: text('quoted_text').notNull(),
    /** JSON: text-quote anchor (quote/prefix/suffix/position hint). */
    anchor: text('anchor').notNull(),
    status: text('status').notNull().default('open'),
    createdVersionId: text('created_version_id')
      .notNull()
      .references(() => versions.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    resolvedBy: text('resolved_by'),
  },
  (table) => [index('comments_document_id_idx').on(table.documentId)],
);

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;

export const commentAnchorStates = sqliteTable(
  'comment_anchor_states',
  {
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id),
    versionId: text('version_id')
      .notNull()
      .references(() => versions.id),
    /** 'anchored' | 'ambiguous' | 'orphaned' */
    state: text('state').notNull(),
    start: integer('start'),
    end: integer('end'),
  },
  (table) => [primaryKey({ columns: [table.commentId, table.versionId] })],
);

export type CommentAnchorState = typeof commentAnchorStates.$inferSelect;
export type NewCommentAnchorState = typeof commentAnchorStates.$inferInsert;

export const watches = sqliteTable(
  'watches',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /**
     * 'watching' | 'unwatched'. An explicit 'unwatched' row is sticky: it
     * records that the user opted out, so auto-watch (create/comment) never
     * re-subscribes them — only the Watch button does.
     */
    state: text('state').notNull(),
    /** Digest cursor: comments created at or before this instant were already emailed (or predate the watch). */
    lastNotifiedAt: integer('last_notified_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.userId] })],
);

export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
