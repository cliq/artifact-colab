# Self Sign-Up & First-Run Team Wizard — Design

**Date:** 2026-08-08
**Status:** Approved for planning

## Summary

Let people sign up and create their own team without waiting for an instance admin. A new `SELF_SIGNUP`
instance flag (default **off**) opens the sign-in code gate to any email. New users who finish sign-in with
zero teams see a first-run **wizard** in place of today's empty state: name a team, and — when their email
domain is eligible — choose between **domain auto-join** ("anyone @acme.com joins automatically") and
**invite-only**. The creator becomes the team's **team admin**. Everything downstream (invites, domain
auto-join, team settings, admin oversight) reuses the existing teams machinery; no schema changes.

## Decisions (settled during brainstorming)

- **Open signup with a kill switch**: `SELF_SIGNUP=true` enables it; the default is **off**, so upgrading an
  existing locked-down instance changes nothing.
- **One unified flow**: no separate signup page. `/signin` serves everyone; when the flag is on, its copy
  reads "Sign in or create an account".
- **Domain auto-join stays silent**: a new user whose domain matches a `team_domains` row is auto-joined at
  sign-in (existing behavior) and never sees the wizard.
- **A domain maps to exactly one team** (already structural: `team_domains.domain` is the PK).
- **Self-serve domain claiming, own domain only**: the wizard can claim only the domain of the creator's
  verified email, only if unclaimed, and never a free-email provider domain. No admin approval step.
- **Wizard-only team creation** (Approach A): users with an existing team get no create-team UI, and domain
  claiming is a one-shot at creation time — changing domains later remains instance-admin-only, per the
  team-admins spec. Broader self-serve (create more teams, claim/release domains from team settings) is an
  explicit follow-up, not part of this design.

## Config & gating

- New `selfSignup: boolean` in `src/server/config.ts`, from env `SELF_SIGNUP` (default `false`). Added to
  `.env.example`, `docker-compose.yml` (it enumerates env keys), and the README.
- `canRequestCode()` in `src/server/services/teams.ts` gains one branch: when the flag is on, **any** email
  may request a code. When off, behavior is unchanged, including the silent `{ok: true}` for rejected emails
  (no enumeration on locked-down instances). The `DEV_LOGIN_CODE` bypass path in `/auth/verify-code` consults
  the same function, so it inherits the flag automatically.
- Existing abuse limits apply unchanged: 10 codes/hour/email, 5 attempts per code, 10-minute TTL. No new
  rate-limiting machinery.

## Sign-up flow

1. Visitor opens `/signin` (copy: "Sign in or create an account" when the flag is on), enters email, receives
   the 6-digit code, verifies.
2. `getOrCreateUser` creates the user row; `materializeMemberships()` runs as today (pending invites convert,
   domain auto-join applies unless excluded). A user who lands in a team this way proceeds straight to their
   documents — no wizard.
3. A user with **zero teams** sees the wizard in place of the "You're not a member of any team yet" empty
   state in `src/server/pages/documents.tsx`. With the flag off, the current empty state renders unchanged.

## The wizard

A single form rendered as the zero-team empty state:

1. **Team name** — required; same validation as the admin create-team form.
2. **Who can join** — rendered only when the user's email domain is *eligible*: not on a hardcoded blocklist
   of free-email providers (gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, msn.com,
   yahoo.com, icloud.com, me.com, mac.com, proton.me, protonmail.com, aol.com, gmx.com, gmx.net, mail.com,
   zoho.com, yandex.com, fastmail.com — a constant in code, extendable later) and not already present in
   `team_domains`. When eligible, two radio options:
   - **"Anyone @«domain» joins automatically"** — claims the domain for the new team;
   - **"Invite-only"** — no domain row; the creator invites people from the existing team settings page.

   When ineligible, the choice is omitted entirely (no greyed-out option) and the team is invite-only.

Submitting creates, in one transaction: the team (via the existing `createTeam()` service, extended or
wrapped), a `team_members` row with `role: 'admin'` for the creator, and the `team_domains` row when auto-join
was chosen. Then redirect to the documents page. Because the creator is a team admin, the existing
`/teams/:id/settings` page (invite, rename, roles) works with no changes, and the team appears in the instance
admin's `/admin` list automatically — oversight, including removing a claimed domain, needs no new UI.

## Route

`POST /teams` — session-authenticated, CSRF-protected (outside the `/auth/*` CSRF-exempt prefixes). Accepts
`name` and optional `claimDomain` (boolean). Server-side validation, independent of what the form displayed:

- `SELF_SIGNUP` must be on, else **404** (invisibility convention);
- requester must be authenticated (existing `sessionAuth` middleware);
- requester must currently belong to **zero teams** (this endpoint serves only the wizard; it is not a
  general create-team API);
- `name` non-empty;
- when `claimDomain` is set: the domain is **derived from the requester's verified email**, never from client
  input; it must pass the free-email blocklist and have no `team_domains` row.

## Error handling

- Validation failures re-render the wizard with an inline error message (matching existing form-error
  patterns); 400 JSON for non-form clients.
- Concurrent claims of the same domain are settled by the `team_domains` primary key: the losing transaction
  fails and the wizard shows "That domain was just claimed by another team — sign in again to join it, or
  create an invite-only team." No automatic fallback; retry by hand is fine at this rarity.
- Flag off or already-in-a-team → `POST /teams` returns 404.
- Sign-in code flow behavior (rate limits, attempts, TTL) unchanged.

## Testing

- Unit — gate: `canRequestCode` matrix with flag on/off × (stranger, existing user, invited email, domain
  match, instance-admin email).
- Unit — eligibility: free-email domain blocked; already-claimed domain blocked; eligible domain allowed;
  domain always derived from the session user's email.
- Unit — route: anonymous → 404; user with an existing team → 404; flag off → 404; happy paths for both
  auto-join and invite-only; claim race via a pre-inserted `team_domains` row → inline error and no
  half-created team (transaction rolled back).
- E2E (Playwright, using existing `DEV_LOGIN_CODE_FILE` / `DEV_EMAIL_FILE` plumbing): with `SELF_SIGNUP=true`,
  a fresh `@example-co.com` user signs up, creates a team with domain auto-join, and a second
  `@example-co.com` user then signs up and lands directly in that team with no wizard.
- No schema migration: every table touched already exists.

## Out of scope

- Creating additional teams from the main UI for users who already have one.
- Team admins claiming/releasing domains after creation (follow-up candidate).
- Admin approval queues, domain allowlists for signup, CAPTCHAs, or IP-based rate limiting.
- Any change to auth methods, invites, tokens, or the teams data model.
