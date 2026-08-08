# Teams, Team Admins & Instance Admins — Design

**Date:** 2026-08-07
**Status:** Approved for planning

## Summary

Replace the `ALLOWED_DOMAINS` env-var allowlist with a first-class teams model. A **team** is the tenancy
boundary (what a domain is today): documents belong to a team and are visible only to its members. **Team
admins** manage a team's people; **instance admins** manage teams, domains, and other admins. Members can be
invited across email domains (e.g. the cliq.dev team invites a gmail.com contractor), and a domain can be
attached to a team so anyone signing in from it auto-joins — letting a domain onboard without anyone from that
domain being an admin.

## Decisions (settled during brainstorming)

- Teams are a **full tenancy boundary**; one instance hosts multiple isolated teams.
- A user can belong to **multiple teams**.
- **Instance admins** bootstrap from `INSTANCE_ADMIN_EMAILS` (comma-separated env var); more can be
  promoted/demoted in the UI. Env-listed admins cannot be demoted (recovery path). Multiple instance admins
  are supported.
- **Tokens are team-scoped**: each MCP/publish token is created for one team; publishes land in that team.
- **Invites are by email with auto-join**: no accept step; signing in with the normal 6-digit code redeems the
  invite (the code proves email ownership).
- **Existing installs auto-migrate**: one team per existing domain; `ALLOWED_DOMAINS` is then ignored (boot
  warning if still set).
- **Only instance admins manage a team's auto-join domains** (attaching a domain claims a whole sign-up
  stream); team admins manage people.

## Data model

New tables (drizzle; 16-hex ids, epoch-ms timestamps, matching existing conventions):

```
teams          id PK · name NOT NULL · created_at
team_members   team_id FK → teams · user_id FK → users · role ('member'|'admin')
               · created_at · PK (team_id, user_id)
team_domains   domain PK (lowercased) · team_id FK → teams · created_at
team_invites   id PK · team_id FK → teams · email (lowercased) · role default 'member'
               · invited_by FK → users · created_at · UNIQUE (team_id, email)
team_exclusions  team_id FK → teams · user_id FK → users · created_at · PK (team_id, user_id)
```

*(Added during review: `team_exclusions` are sticky removal tombstones. Without them, removing a member whose
email domain is attached to the team would silently undo itself on their next sign-in via domain auto-join.
Domain auto-join skips excluded users; an explicit invite/re-add clears the tombstone.)*

Changed tables:

- `documents`: `team_id` FK → teams **replaces** `domain` (indexed). SQLite requires a table-recreate;
  migrations auto-apply at boot.
- `tokens`: adds `team_id` FK → teams.
- `users`: adds `is_instance_admin` (boolean, default false); **drops `domain`**.

Semantics:

- `team_domains.domain` being the primary key structurally guarantees a domain auto-joins exactly one team.
- Exactly two team roles. `member`: view, comment, publish via team-scoped tokens. `admin`: additionally
  invite/remove members, promote/demote team admins, cancel invites, rename the team.
- Instance admins are **not implicit members** of every team. They manage teams from `/admin` (including
  adding themselves as a member) but only see a team's documents if they are a member.
- Instance-admin status at runtime = `users.is_instance_admin` OR email ∈ `INSTANCE_ADMIN_EMAILS`.

## Sign-in, joining & access checks

**Sign-in gate** — replaces `isAllowedDomain` at both call sites in `routes/auth.ts`. An email may request a
code if any of:

1. its domain matches a `team_domains` row;
2. it has a pending `team_invites` row;
3. it is listed in `INSTANCE_ADMIN_EMAILS`;
4. it belongs to an existing user (removing a domain rule never locks out existing members; removing a person
   is done via member removal).

Rejected emails still receive the silent `{ok: true}` response — no account/domain enumeration, as today.

**Membership materialization** — runs in `getOrCreateUser`'s transaction at `verify-code` time:

- every pending `team_invites` row for the email converts to a `team_members` row (with the invite's role) and
  is deleted;
- if the email's domain matches a `team_domains` row and the user isn't already a member of that team, they
  join as `member`. This runs on **every sign-in**, so attaching a domain later pulls in existing users on
  their next sign-in.

Exception: inviting an email that already has an account converts to membership **immediately** at invite time
(ownership is already proven; waiting for their next sign-in would be surprising).

**Access checks** — one helper replaces the ~15 `documents.domain = user.domain` call sites:

- `findDocumentForUser(db, slug, userId)`: joins `documents → team_members`; no row → **404** (preserves the
  "cross-tenant rows 404, not 403" convention).
- Document list: all documents from all the user's teams; grouped by team when the user has more than one,
  flat otherwise.
- Publishing stamps `team_id` from the **token**, not the user; MCP tools and `/api/publish` /
  `/api/docs/:slug/raw` scope every lookup by the token's team. Republishing a doc via a token from a
  different team → 404.
- Token creation (Connect page + JSON route) requires picking a team when the user has several; defaults to
  the only team otherwise. Removing a user from a team **revokes that team's tokens belonging to them** and
  **deletes their `watches` rows for that team's documents** — otherwise the digest sweep (which emails every
  `'watching'` row without re-checking access) would keep sending them comments on documents they can no
  longer open.
- A user with zero teams can still sign in but sees an empty state; no documents, no token creation.
- Commenting/resolving stays team-wide (any member); roles do not gate commenting.

## Admin surfaces

Server-rendered pages, session-authed, CSRF-protected (not under exempt prefixes).

**Instance admin — `/admin`** (nav link visible only to instance admins):

- Teams list with create-team (name). Per-team page: rename, attached domains (add/remove), members (add by
  email, remove, toggle team-admin), pending invites, delete team.
- Delete team cascades: documents (versions/assets/comments/watches), memberships, domain rules, invites, and
  team-scoped tokens. `watches` has no `ON DELETE CASCADE`, so the cascade deletes it explicitly. Requires a
  confirmation step.
- Instance admins section: list, promote by email, demote. Env-listed emails render as locked.
- "Add member by email" uses the invite mechanism (pending row if no account; immediate membership if one
  exists) — one code path.

**Team admin — team settings** (linked from the doc list header for teams where the user is team admin):

- Members: invite by email (sends invite email via Resend), remove, promote/demote team admin, cancel pending
  invites.
- Rename team. Domains are instance-admin-only.

**Authorization helpers** (new): `requireInstanceAdmin(c)` and `requireTeamAdmin(c, teamId)`, both returning
404 on failure. Instance admins do **not** implicitly pass team-admin checks; they act through `/admin`.

**Invite email**: "«inviter» invited you to «team» on Artifact Colab", linking to `/signin`. The link carries
no token — the invite is redeemed by the normal code flow, so the email is a notification, not a credential.
Sent via the existing Resend setup and diverted by `DEV_EMAIL_FILE` in dev/tests, like comment digests.

**Guardrails**: demoting/removing the last team admin is allowed (instance admins can re-appoint). Demoting
the last instance admin is blocked; env-listed admin emails cannot be demoted at all.

## Migration & rollout

One drizzle migration (schema + SQL data backfill), auto-applied at boot:

1. Create the four new tables.
2. One team per distinct domain in `users.domain ∪ documents.domain`, named after the domain, ids via
   `lower(hex(randomblob(8)))`.
3. Each domain becomes a `team_domains` row for its team.
4. Every user becomes a `member` of their domain's team. Nobody is auto-promoted to team admin — instance
   admins appoint afterward; domain auto-join keeps sign-ins working meanwhile.
5. `documents.team_id` backfilled from `documents.domain`, then `domain` dropped (table-recreate). `users.domain`
   dropped likewise.
6. `tokens.team_id` backfilled to the owner's (single pre-migration) team.

Config:

- New `INSTANCE_ADMIN_EMAILS` env var, parsed with the existing `parseCommaSeparated` (lowercased). Added to
  `config.ts`, `.env.example`, `docker-compose.yml` (it enumerates env keys), README.
- `ALLOWED_DOMAINS` removed from config; if set at boot, log a one-line warning pointing at the admin UI.

Fresh installs: with no teams/domains, only `INSTANCE_ADMIN_EMAILS` can sign in; the admin creates a team and
attaches a domain or invites people. Empty database is secure by default.

Existing sessions and tokens survive the migration; nothing is invalidated.

## Error handling

- Unauthorized access to documents, `/admin`, or team settings → 404 (invisibility convention).
- Validation failures (bad email, duplicate domain, unknown team) → inline form errors on pages, 400 JSON on
  API routes.
- Sign-in code flow behavior (rate limits, attempts, TTL) unchanged.

## Testing

- Unit: sign-in gate matrix (domain rule / invite / admin email / existing user / stranger); membership
  materialization (invite conversion, domain auto-join on later sign-ins, immediate conversion for existing
  accounts); `findDocumentForUser`; guardrails (last instance admin, env-email demotion); token-team publish
  scoping including cross-team republish → 404; member removal stops comment digests (watch rows gone, sweep
  sends nothing); team deletion leaves no orphaned watches/tokens/invites.
- Migration: seed a pre-migration DB shape, run the migration, assert teams/domain rules/memberships/backfills.
- Update existing tests pinned to the old model: `test/server/auth.test.ts` (allowlist cases),
  `pages.test.ts` (cross-domain fixture), `api.test.ts`, `mcp.test.ts`, `publish.test.ts`, `db.test.ts`,
  `anchorStates.test.ts` (`allowedDomains` / `domain:` fixtures).
- E2E: extend `happy-path.spec.ts` — admin creates a team, invites a gmail user; that user signs in with the
  dev code, sees the team's document, comments.

## Out of scope

- Per-document ACLs or sharing outside a team; public/unlisted links.
- Team admins managing auto-join domains; wildcard/subdomain matching.
- A "current team" switcher or per-team session state (the merged, membership-checked view makes it
  unnecessary).
- SSO or auth methods beyond the existing email code flow.
