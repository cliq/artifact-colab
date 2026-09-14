# Private artifact collaboration — plan

**Date:** 2026-09-14

**Status:** Implemented on `feature/private-collaboration`; release verification recorded below.

## Outcome

Replace **Only you** in the sharing menu with **Private**. A private artifact starts with access for its owner alone. The owner can invite people by entering/tagging their email addresses and choosing Viewer or Editor for each invitation. Invitees may belong to the same team, another team, or have no account yet. Each invitation grants access to one artifact without adding the recipient to its team.

Example: Alice makes an artifact Private, invites Bob from her team as Viewer, and invites an external email as Editor. Uninvited teammates cannot open it. The external recipient verifies their email, accepts the invitation, and collaborates without joining Alice's team.

## Confirmed decisions

- Rename the sharing option to **Private**; without invitations, access is owner-only.
- Choose **Viewer** or **Editor** per invitation.
- Only the artifact owner can invite more collaborators.
- Support invitations to existing users and people without accounts.
- Support collaborators within and across teams.
- Invitations grant artifact access only, with no team membership grant.

## Proposed defaults for review

These details were not settled in the initial questions. The plan uses the following assumptions:

- “By default only available to me” describes the Private setting. Keep the existing new-artifact publishing default of `team`; changing all new artifacts to Private would be a separate explicit decision.
- Viewer means read-only: view all versions, comparisons, comments, assets and exports; optionally watch notifications. Editor additionally comments, replies, reacts, resolves/reopens threads, and publishes new versions or updates the title/assets.
- Only the owner manages invitations, changes roles, removes collaborators, or changes a private artifact's visibility. Editor does not imply ownership, deletion, or team administration.
- Email tagging happens in the Share panel. Typing `@email` in a comment does not grant access. Inviting from a comment composer can be a later enhancement with an explicit owner action and role selection.
- Both existing and new users explicitly accept an invitation. Default the invite role to Viewer.
- Pending invitations expire after seven days; accepted access lasts until revoked. Resending renews a pending invitation; changing its role is explicit.
- Explicit grants remain applicable across Private, Team, and Public visibility. Broader visibility can give someone additional rights; the UI explains this before changing visibility or removing a grant.
- Keep the existing requirement that the owner remain a member of the artifact's owning team. If removed, suspend invitations and explicit grants until ownership is restored or a future recovery policy is applied. Ordinary collaborator grants are independent of the collaborator's team memberships.

## Current implementation and implications

| Area | Current behavior | Required change |
| --- | --- | --- |
| Storage and copy | `documents.visibility` already supports `private`; menu says “Only you” | Keep the stored value; replace owner-only copy |
| Authorization | `findDocumentForViewer`, `findDocumentForUser`, and `findDocumentInTeam` in `routes/api.ts` encode creator-only private access | Resolve explicit grants and separate read, interaction, publish, and management capabilities |
| Publishing | `services/publish.ts` and bearer tokens require the artifact's team | Provide a usable publishing path for external and teamless Editors without expanding team token scope |
| Sign-in | `canRequestCode` considers team invites; `getOrCreateUser` materializes team membership | Admit valid artifact invitees without treating an artifact invite as a team invite |
| Discovery | Team lists hide others' private artifacts; “Shared with you” uses watches on public artifacts | Discover accepted grants independently of notification subscriptions |
| Mentions | Private documents resolve only the creator; private autocomplete is empty | Resolve existing authorized collaborators, including external users |
| Notifications | Visibility changes prune watches; the digest sweep assumes every watch is authorized | Preserve authorized collaborators and stop delivery to revoked users |
| Cleanup | Document/team deletion explicitly removes child rows | Include grants and invitations in cascades |

Relevant sources: `src/server/db/schema.ts`, `src/server/routes/{api,document,pages,frame,publish,tokens}.*`, `src/server/services/{documents,publish,teams,watches}.ts`, `src/server/auth.ts`, `src/server/mcp.ts`, `src/server/pages/{document,documents}.tsx`, and `src/client/viewer.ts`.

## Sharing experience

1. The owner opens Share and selects **Private**. Help text reads “Only you and people you invite can access this artifact.” With no collaborators, the panel says “Only you have access.”
2. The owner enters a full email address, optionally prefixed with `@`. Each address becomes a removable chip with its own Viewer/Editor role. Validate and normalize addresses before submitting; prevent duplicate addresses and invitations to the owner.
3. The owner selects **Send invitations**. Each recipient receives an email with the artifact title, inviter, assigned role, and an acceptance link. The panel distinguishes Pending, Accepted, Expired, and delivery failure states.
4. The owner can change roles, revoke accepted access, cancel pending invitations, and resend pending or expired invitations. Report partial delivery failures per recipient without duplicating successful invitations.
5. Collaborators see their effective role and can copy the artifact URL. Sharing that URL alone gives nobody additional private access. Invitation management controls appear only for the owner.

Autocomplete may suggest people already visible to the owner through their teams or this artifact. Allow arbitrary valid emails without searching or exposing a global user directory. Return the same invite response shape whether an email already has an account.

Show accepted private artifacts in the appropriate team list for invited teammates and in “Shared with you” for external/teamless collaborators. Avoid duplicate rows. Discovery must work immediately after acceptance even if the user never comments or watches. Team creation must not interrupt invitation acceptance or artifact access.

## Requesting edit permission

Viewers with an accepted grant can select **Request edit permission** in Share when they lack effective publishing permission. The configured email sender notifies the owner with the requester, artifact title, and a link that opens its Share panel. The owner changes the collaborator role there; requesting permission never upgrades access automatically. Public access may allow an invited Viewer to comment while they still need Editor permission to publish.

Requests are limited to one successful email per collaborator/artifact per day, with burst protection. A delivery failure is reported and allows a retry. Only currently authorized collaborators can request permission, and existing publishing rights suppress the button.

## Permissions

For a private artifact with an active owner:

| Capability | Owner | Editor | Viewer | Uninvited user, including teammate/admin |
| --- | --- | --- | --- | --- |
| View artifact, versions, comparisons, comments, assets; export | Yes | Yes | Yes | No |
| Watch/unwatch | Yes | Yes | Yes | No |
| Comment, reply, react, resolve/reopen | Yes | Yes | No | No |
| Publish version, update title/assets | Yes | Yes | No | No |
| Invite, cancel/resend, change roles, remove collaborators | Yes | No | No | No |
| Change visibility | Yes | No | No | No |
| Delete artifact through its normal UI/API | Yes | No | No | No |

Keep administrative team deletion/cleanup as an explicit existing administrative operation; it does not grant private reading or invitation rights. A team admin explicitly invited as Editor has Editor capabilities, not owner capabilities.

Introduce a shared authorization service returning the document and capabilities such as `canRead`, `canComment`, `canPublish`, `canManageAccess`, and `canDelete`, plus membership and effective role. Use the same policy in scoped listing queries. Do not infer editing or management permission from `isMember` or from successful read access.

For Team/Public artifacts, preserve existing baseline access and combine it with active explicit grants. Private ignores baseline teammate access. A grant never reduces rights already supplied by broader visibility: an invited Viewer on a Public artifact can still interact under the existing Public policy. Switching back to Private restores the explicit role limits. Only the owner may transition an artifact out of Private; retain existing team/public management rules otherwise.

Return the existing 404 for users with no read access. A user who can read but lacks a requested capability receives 403. Check authorization on the server after reading request bodies and immediately before mutations, including calls addressed by comment or version ID.

## Invitation and grant storage

Add two artifact-scoped tables through a Drizzle migration:

- `document_invitations`: ID, document ID, normalized email, role (`viewer`/`editor`), inviter ID, hashed random acceptance token, creation/update/expiry timestamps, status (`pending`/`accepted`/`revoked`/`expired`), accepted user/time, and last delivery result/time. Keep one current invitation per document/email; resend rotates its token. An accepted invitation cannot be resent to recreate removed access.
- `document_collaborators`: document ID, user ID, role, grantor ID, created/updated timestamps; unique on document/user. The owner remains derived from `documents.createdBy` and is not a collaborator row.

Index invitations by normalized email/status and token hash, and collaborators by user/document for discovery. Validate roles at the service boundary and constrain them in storage. Add foreign keys and extend explicit deletion cascades. No backfilled collaborator rows: existing private artifacts remain owner-only after migration.

Invitation role changes update the pending invitation. Accepted role changes update the grant. Revoking a grant also invalidates any invitation capable of recreating it. Use transactions for acceptance, role changes, revocation, and cleanup; acceptance races must resolve to one grant using the current invitation role and status.

## Acceptance and authentication

1. The invitation link opens a minimal landing page. A GET never accepts an invitation; mail scanners must not consume it. The link is not a credential for opening the private artifact.
2. Require sign-in with the exact normalized invited email, using the existing email code flow. A different signed-in account receives an account-switch prompt without artifact content.
3. Extend `canRequestCode` to recognize a live artifact invitation, including when self-signup is disabled. Recheck validity when admitting a new account so cancellation during code verification cannot redeem the invitation.
4. After verification, an explicit CSRF-protected acceptance POST validates the token hash, email, expiry, pending state, artifact existence, and active owner. Atomically create the grant and mark the invite accepted, then redirect to `/d/:slug` using existing safe redirect handling.
5. Reopening an accepted link is safe for its recipient if access still exists. Expired, cancelled, deleted-artifact, and revoked-access links offer no access. Resend invalidates earlier pending links.

Artifact acceptance must not write `team_members` or `team_invites`, claim a domain, or create a personal team. Existing unrelated team invitations/domain auto-join remain independent sign-in policies; document invitations must not introduce a new team admission rule. Do not force the team setup wizard on an invitee's route to the artifact.

Use cryptographically random tokens stored only as hashes, avoid placing them in logs, and apply rate limits to invitations/resends and the existing OTP flow. Send email after committing invitation state, recording failure so the owner can retry. Reuse the configured email sender; do not send real invitations during implementation tests.

Artifact-only describes the grant, not a new account-wide sandbox. Under the existing Public policy, any authenticated account may also open Public artifacts with their links. This remains an explicit compatibility consequence, including on instances where an invitation enables signup.

## Making Editor usable across teams

Today, creating a token requires a team and publishing requires that token's team to match the artifact. Merely adding an Editor grant would not let an external collaborator revise an artifact.

Proposed first release: add an **Upload new version** action for owners and Editors on the artifact page, backed by a new session-authenticated, CSRF-protected artifact-specific endpoint. Accept the existing HTML/Markdown and asset inputs, use the same limits/rendering/anchoring pipeline, and require `canPublish` for that artifact. The Editor cannot change `teamId`, `createdBy`, or visibility through this operation. This offers teamless users a complete editing workflow without creating a team or a new token system.

Refactor the publish service so authorization is explicit for both callers: the existing bearer path retains its team boundary, and the session path accepts only an existing authorized artifact. Update MCP and REST checks so same-team invited Viewers cannot publish or mutate comments and Editors cannot use a visibility field to broaden access. Recheck capabilities for each MCP tool invocation, not only at connection initialization.

Cross-team MCP/token publishing is outside this proposed first release. If required, design artifact-scoped credentials separately; never silently allow a token belonging to one team to reach another team's artifacts. The UI should make the supported upload workflow available to every Editor.

## Mentions, revocation, and visibility changes

- Private mention suggestions include only the owner and accepted authorized collaborators, with the same filtering in comment processing. Pending or uninvited addresses remain plain text and receive no comment notifications.
- A Viewer may be mentioned and receive notifications despite having no comment permission. Preserve explicit watch preferences according to the current mention/watch behavior.
- Revoking private access removes all watch states for that user/artifact in the same transaction and removes discovery access. Existing comments and publication attribution remain.
- A role downgrade immediately blocks further editing, including from already-open pages or connected agents; it does not remove read access or watches.
- Visibility changes prune watches only for people who lose effective read access. Switching Public/Team to Private must preserve active invitees. Removing a grant on a broader artifact may leave baseline access; explain that in the owner UI.
- Team member removal continues to revoke that team's tokens. Preserve an ordinary collaborator's independent grant and eligible watch; owner removal suspends explicit grants/invitations and prunes watches that lose access. Prevent acceptance while suspended.
- Recheck effective read permission immediately before each digest send, as well as pruning watches transactionally. A watch list fetched before revocation must not cause a later unauthorized email. Already delivered or in-flight email cannot be recalled.
- Deleting an artifact or its team removes invitations and grants along with existing children. Existing orphaned-private-artifact admin cleanup must account for suspended collaborators.

## Implementation sequence

1. **Schema and access policy:** add tables/migration, implement capability resolution and grant services, cover the private permission matrix. Replace creator-only checks across viewer, frame, metadata, exports, comment/reaction routes, listings, MCP, and publish paths without broadening existing token scope.
2. **Invitation lifecycle:** add owner-only create/list/update/revoke/resend endpoints; add the acceptance landing page and POST; implement email delivery and invite-aware sign-in with teamless acceptance.
3. **Share UI and discovery:** rename the option, add email chips and individual roles, pending/accepted management, effective-role display, and grant-based listings. Update menu notes, badges/tooltips, and agent-facing private descriptions.
4. **Editor workflow:** add the session upload endpoint and UI, reuse publishing validation and anchoring, and enforce role/visibility boundaries in both session and bearer publishing.
5. **Lifecycle integration:** update mentions, watch pruning, digest checks, membership removal, and deletion cascades. Update README usage and relevant existing tests.
6. **Release verification:** run the matrix below, the repository checks, and browser tests; release backend/schema/UI together so invitations are not exposed before all access paths enforce roles.

## Validation and acceptance criteria

- Existing Private artifacts still open only for their owners after migration; existing Team/Public rows and creation defaults remain unchanged under the proposed interpretation.
- Exercise owner, same-team Viewer/Editor, cross-team Viewer/Editor, teamless invitee, uninvited teammate, uninvited admin, and unrelated user against every permission in the matrix.
- Cover current and historical frames, comparisons, metadata, HTML/Markdown/ZIP/JSON exports, assets, comments, replies, reactions, resolve/reopen, watches, raw bearer fetch, REST publish, and MCP tools. Denied operations must leave no partial writes.
- Verify only the owner can invite, resend, cancel, change roles, remove access, or move Private to a broader setting; enforce this for direct requests as well as UI controls.
- Verify normalized email matching, duplicates, different-account acceptance, expiration, token rotation, repeated acceptance, revocation before/during acceptance, role-change races, and deleted/suspended artifacts.
- With self-signup disabled, a valid new invitee can verify and accept; an invalid/cancelled invite cannot authorize new signup. Acceptance creates no team, membership, team invite, or token.
- Accepted artifacts appear without a watch; unwatched artifacts remain discoverable; revoked private artifacts disappear. Same-team invitees are listed once.
- An external/teamless Editor uploads a new version with correct author attribution and anchoring; a Viewer cannot. A team-scoped token cannot cross teams, and a same-team Viewer token cannot bypass its role.
- Uninvited comment mentions never grant access or send notifications. Revocation and visibility changes prune the correct watches; a digest sweep with stale recipients rechecks access before delivery.
- Test membership removal, owner suspension/restoration, and document/team cascades without resurrecting revoked grants or subscriptions.
- Verify Viewer edit requests email only the active owner, open Share, enforce cooldowns, allow delivery retries, and never upgrade the requester automatically.
- Extend `test/server/privateVisibility.test.ts`, `sharing.test.ts`, `auth.test.ts`, `selfSignup.test.ts`, `watches.test.ts`, `publish.test.ts`, `mcp.test.ts`, and deletion/migration coverage as relevant; add focused invitation tests and browser coverage for invite → verify → accept → collaborate → downgrade/revoke.
- Implementation completion requires `npm run check`, `npm run build`, and relevant `npm run e2e` tests to pass. This planning-only change requires documentation review and a clean whitespace diff, not application tests.

## Review points before implementation

The confirmed decisions above stand. Review the proposed interpretation of the creation default, the read-only Viewer definition, session upload as the first external editing workflow, grant persistence across visibility changes, and owner-removal suspension. These choices determine product behavior beyond renaming the sharing option.

## Implementation verification

Implemented on `feature/private-collaboration` with migration `0010_private-collaboration` and the additional Viewer edit-request flow above. Backend, schema, and UI ship together. No backfill grants are created.

Verification on 2026-09-14:

- `npm run check`: TypeScript and 367 tests passed, including invitation/auth lifecycle, the private capability matrix, team-scoped MCP/REST boundaries, streamed-request downgrades, stale digest recipients, and migration preservation.
- `npm run build`: annotator, viewer, and server builds passed.
- `npm run e2e`: all 28 Chromium tests passed, including invite → verify → accept → request Editor → owner changes role → upload → downgrade → revoke.
- `git diff --check`: passed.

Invitation and edit-request emails were verified using local test delivery files; no real invitations were sent during implementation tests.
