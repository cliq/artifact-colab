# Public Sharing (Anyone Signed In) — Design

**Date:** 2026-08-18
**Status:** Approved for implementation

## Summary

Let a team share an artifact outside its team: a document can be flipped from **team-only** (today's
behavior, the default) to **public**, meaning *any signed-in user of the instance who has the URL* can open
it and fully interact — view every version, read all comments, comment, reply, resolve/reopen, watch, and
export. There is no anonymous access: every viewer is an authenticated user, so comment authorship, watches,
and digests keep working unchanged. The document is never listed for non-members; the unguessable 10-char
base58 slug is the link secret (same semantics as "anyone in the org with the link").

The instance operator still controls the audience: "anyone signed in" is bounded by the existing sign-in gate
(`canRequestCode`) — self-signup, domain rules, invites. On a locked-down instance, "public" quietly means
"anyone in the company".

## Decisions (settled during brainstorming)

- **Always signed in.** No anonymous viewing, no share tokens, no separate share route. `/d/:slug` stays the
  canonical URL for everyone.
- **Everything travels.** Public viewers see all versions, all comment threads (including the team's internal
  ones), and both export formats.
- **Full interaction.** Public viewers comment, reply, resolve/reopen, and watch, exactly like members.
  Commenting stays role-independent.
- **Members-only:** delete the document, publish new versions (already token/team-scoped), and toggle
  visibility itself. Any member may toggle (consistent with the flat publish/comment model).
- **Revocation = flip back to team.** A non-member hitting a flipped document gets the standard 404
  (invisibility convention kept: since every viewer is identifiable, a "no longer shared" page would leak that
  the document exists and that they once had access).
- **Discovery**: the home page gets a **"Shared with you"** section — public documents outside the user's
  teams that they have a watch row on (commenting auto-watches, so interacting is enough to pin a document
  there).
- **Guest tag**: comments authored by non-members render with a small "guest" badge, so the team can see a
  thread has outside eyes.

## Data model

One new column, no new tables:

```
documents  + visibility  text NOT NULL DEFAULT 'team'   -- 'team' | 'public'
```

`documents.teamId` remains the owner; visibility is an access widening, not an ownership change. Migration is
a single `ALTER TABLE ... ADD COLUMN`; existing rows default to `'team'` (no behavior change on upgrade).

## Access checks

`findDocumentForUser` (member-only) stays as-is for member-gated actions. A new sibling becomes the read/
interact chokepoint:

- `findDocumentForViewer(db, slug, userId)` → `{ document, isMember } | undefined`: LEFT JOIN on
  `team_members`; row matches when the user is a member **or** `visibility = 'public'`. Non-match → 404, as
  today.

Call-site changes:

| Surface | Check |
|---|---|
| `GET /d/:slug` (viewer page), `GET /d/:slug/frame` | viewer |
| `GET/POST /api/docs/:slug/comments`, replies, resolve, reopen | viewer |
| `GET /api/docs/:slug`, `export.json`, `export.md` | viewer |
| `POST /d/:slug/watch` | viewer |
| Delete flow (`/d/:slug/delete`) | member **and** (author or team admin) — membership is now explicit, so a public doc's creator who left the team can no longer delete it |
| `POST /d/:slug/share` (new) | member |
| MCP tools, `/api/publish`, `/raw` | unchanged (token-team-scoped) |

The frame needs no extra hardening: it already serves publisher HTML with a response-level
`Content-Security-Policy: sandbox allow-scripts` (opaque origin, no cookies, assets inlined as `data:` URIs),
so widening who can fetch it is safe.

## Watches & digests (the correctness trap)

The digest sweep emails every `'watching'` row **without re-checking access** (the same invariant that makes
`removeMember` delete watches). Therefore flipping a document back to `'team'` must, in the same transaction,
delete all watch rows belonging to non-members of the document's team — otherwise revoked outsiders keep
receiving comment digests. This lives in one service function used by every flip path:

- `setDocumentVisibility(db, document, visibility)`: updates the column; when the new value is `'team'`,
  deletes non-member watch rows for that document.

Side effect that falls out for free: pruning the watch rows also removes the document from the outsiders'
"Shared with you" list.

## UI

**Viewer toolbar** (`/d/:slug`):

- Members get a **Share** menu (a `<details>` like the existing Export menu) showing the current state —
  "Team only" or "Anyone signed in with the link" — with a one-click toggle (CSRF form POST to
  `/d/:slug/share`, redirecting back). When public, the menu shows the URL to copy.
- Non-members see a muted "Shared with you" note instead of the Share menu; Watch and Export work as normal;
  Delete is hidden (member-gated).

**Home page** (`GET /`): a "Shared with you" section listing public documents outside the user's teams where
the user has a watch row (any state — an explicit unwatch mutes email, it shouldn't lose the link). Rendered
with the same table as team groups; shown for zero-team users too (they may have nothing *but* shared
documents).

**Comment sidebar**: the comments API stamps each author DTO with `isGuest` (author is not currently a member
of the document's team); the client renders a small "guest" badge next to the name on threads and replies.

## Agents (MCP / REST publish)

- `publish_artifact` gains an optional `visibility: 'team' | 'public'` input: sets it on create (default
  `'team'`), and updates it on republish when passed (omitted = keep current). Flipping to `'team'` goes
  through `setDocumentVisibility` (watch pruning included). The success text mentions when the URL is
  shareable with anyone signed in.
- `POST /api/publish` accepts the same optional `visibility` form field.
- `get_artifact` reports the document's visibility in its header line.

## Error handling

- Non-member (and revoked) access to a team-only document → 404 everywhere, as today.
- `POST /d/:slug/share` by a non-member → 404 (member-gated action, invisibility convention).
- Invalid `visibility` value → 400 on API/publish paths, ignored/400 on the form route.

## Testing

- Unit: `findDocumentForViewer` matrix (member/team doc, member/public doc, outsider/team doc → 404,
  outsider/public doc → ok with `isMember: false`); outsider can read/comment/reply/resolve on a public doc;
  guest flag on outsider comments; share toggle member-only; flip-to-team prunes exactly the non-member
  watches (digest sweep sends nothing to outsiders afterwards) and 404s the outsider; "Shared with you"
  section appears for a watching outsider and disappears after the flip; publish honors `visibility` on
  create and republish, omitted keeps current.
- Existing suites unaffected: `findDocumentForUser` keeps member-only semantics; default `'team'` keeps every
  current fixture behaving identically.

## Out of scope

- Anonymous / unauthenticated viewing, share-link tokens, link expiry.
- Per-user grants or per-thread comment visibility.
- Notifying watchers when visibility changes.
- Instance-wide "disable sharing" switch (can be added as an env var later if a self-hoster asks).
