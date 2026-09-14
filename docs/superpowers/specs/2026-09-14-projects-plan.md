# Projects — implementation plan

**Date:** 2026-09-14

**Status:** Implemented on `feature/projects`; verified results are recorded below.

**Reference:** [Project folders — design exploration, version 1](https://artifacts.cliq.dev/d/wU7MsRAfJi?version=1), with the decisions in this plan superseding the original folder terminology and options B/C.

## Outcome

Let a team organize its artifacts into **Projects**. An artifact belongs to zero or one Project in its owning team. Assign a Project by name when publishing, or move an existing artifact through the application or MCP.

The documents list has two personal display modes over the same assignments:

- **Folder view:** Projects appear as rows that open their own artifact lists. Unassigned artifacts appear under **Unfiled**.
- **Tag view:** All accessible artifacts remain in the existing flat team list, with each artifact's Project shown as a tag.

Example: publish a launch brief with `project: "Website launch"`. In Folder view it appears inside Website launch. In Tag view it appears in the flat list with a Website launch tag. Moving it to Brand refresh updates the assignment for everyone, in both views, without publishing a new version or changing sharing.

## Confirmed decisions

- Use **Project** throughout product copy and the agent interface: New project, Move to project, Rename project, Delete project.
- Projects belong to a team and use a shared structure. There are no owner-managed Projects, locks, or personal collections.
- An artifact has at most one Project. Tag view is a presentation mode, not a many-to-many tagging system.
- Support assigning a Project when publishing and moving an existing artifact.
- Derive Project visibility from artifact access and hide Projects from users who cannot access them.
- Agents identify Projects by **name**, scoped to their token's team.
- Provide both Folder view and Tag view.
- Do not implement Undo.
- Address archiving/completed Projects later.

Retain these decisions from the design exploration: one level without nesting, alphabetical Project order, artifact-level sharing, a separate Shared with you section, and deletion of a Project returning its artifacts to Unfiled without deleting them.

## Proposed defaults

These details make the plan implementable but were not individually settled in the discussion:

- Apply artifact-derived Project visibility within the owning team; do not introduce Project invitations or a second set of sharing settings.
- A genuinely empty Project is accessible to all members of its team. A populated Project is accessible only to team members who can read at least one artifact inside it. The distinction is evaluated on the server.
- All team members who can access a Project may rename or delete it. Creating it grants no additional authority.
- Moving an individual artifact requires membership in its owning team and effective artifact editing permission.
- Publishing with an unknown Project name creates it, following the original design. Moving by name requires an existing accessible Project; creation is a separate explicit action in the move picker.
- Default to Folder view and remember the chosen mode per signed-in user in the current browser.
- Confirm Project deletion because it affects the team's organization. Ordinary moves and renames need no confirmation or Undo.

The user confirmed that visibility follows artifact access. The empty-Project exception above keeps creating a shared Project before publishing its first artifact usable without introducing ownership privileges.

## Access and visibility

### One shared policy

Implement `canAccessProject`/`visibleProjectsForTeam` using the existing `readableDocumentCondition` and current team membership:

```text
can access Project =
  current member of the Project's owning team
  AND (
    Project contains no artifacts
    OR at least one contained artifact is readable by this user
  )
```

Use this policy for Folder view, Project pages, move destinations, agent discovery, Project metadata, and every management endpoint. Hidden Projects have no row, placeholder, name, ID, URL, or totals in the response. Direct requests return the same 404 as a missing Project. Team administrators have no private-content visibility override.

For example, a Project containing only Alice's private artifact is hidden from Bob unless Bob can read that artifact. Once an artifact Bob can read is added, the Project becomes visible to Bob, but Alice's private artifact remains hidden. If Bob loses access to the last artifact he could read, the Project disappears for him on the next authorized request.

Genuinely empty Projects remain available to the team, including when their creator leaves. The creator has no special access to a populated Project whose artifacts they cannot read. Projects containing only suspended private artifacts follow the existing private-access suspension rules and may remain hidden until artifact access is restored.

### Artifact access remains authoritative

- Project membership never grants artifact access, invites collaborators, changes visibility, or changes ownership.
- Project pages include only readable artifacts. Artifact counts, open-comment totals, and latest publication time are calculated from that filtered set.
- A visible Project name is shared with its eligible team members; individual artifact privacy does not make that name private from those members.
- External/teamless collaborators and people following a Public artifact link can continue reading or editing that artifact under its existing permissions. They cannot access its owning team's Projects or Project metadata.
- Keep externally shared artifacts in Shared with you. Do not expose their Project tag, breadcrumb, or move controls there.
- Recheck access on each request and after consuming mutation bodies. A stale page, known name, or previously valid token does not preserve access. Mark personalized Project pages/API responses private and non-cacheable by shared caches.

### Management rules

| Operation | Requirement |
| --- | --- |
| Create a Project | Current membership in its team |
| List/open a Project | `canAccessProject` |
| Rename/delete a Project | Current membership and `canAccessProject`; creator/admin status is not required |
| Move an artifact into an existing Project | Current membership in the artifact's team, `canPublish` for the artifact, and access to a destination in the same team |
| Remove an artifact from its Project | Current membership in the artifact's team and `canPublish` for the artifact |
| Publish a new artifact into a Project | Existing team-token publishing authorization plus access to the destination, or creation of an unused Project name |

A teammate invited as Viewer to a private artifact may see its Project but cannot individually move that artifact. An external Editor cannot move it, even though they can upload a new version.

Deleting an accessible Project is explicitly a structural operation: remove the grouping for **all** its artifacts, including artifacts the deleting member cannot read or individually edit. Those artifacts retain their access rules. The confirmation says “Delete this project? Its artifacts will become Unfiled for the team. Artifacts and their sharing settings will be kept.” Do not display an unfiltered affected-artifact count.

### Prevent metadata leaks through existing responses

`GET /api/docs/:slug` currently serializes the result of `resolveDocumentAccess`, including its nested raw `document`. Adding `documents.projectId` would expose it through that path unless the response is changed. Return explicit capability fields and an authorized Project summary instead of serializing raw database objects. Audit viewer bootstrap data, MCP results, upload responses, and exports for the same issue.

Do not change source exports by injecting Project metadata into HTML/Markdown content. Project assignment describes the current artifact, including when viewing an older version; it is not versioned content.

## Names and assignment contract

### Name rules

- Store a display name and a normalized lookup key. Normalize Unicode to NFC, trim surrounding whitespace, collapse whitespace runs to a single space, and lowercase the lookup key while preserving display casing.
- Allow 1–100 Unicode code points after display normalization; reject control characters. Reserve the normalized name `unfiled` for the unassigned state.
- Enforce unique lookup keys **within a team**, including hidden Projects. Identical names in different teams are independent.
- Use the same normalizer in create, rename, publishing, and move operations. Escape names as text in HTML and encode them when constructing URLs or requests.
- A name containing `/` is a literal name, not a hierarchy.

Keep an opaque internal Project ID for relationships and a stable page URL `/p/:id`. Names are the user/agent input; do not add a `project_id` argument to publishing or agent moves. Renaming changes the display/lookup name while preserving assignments and the Project page URL.

### Publishing

Add optional `project` to `publish_artifact` and the multipart `/api/publish` path:

| Input | New artifact | Existing artifact/new version |
| --- | --- | --- |
| `project` omitted | Unfiled | Preserve the assignment that exists when the transaction runs |
| `project: "Website launch"` | Assign to that accessible Project, creating it if absent | Assign to that accessible Project, creating it if absent |
| `project: null` | Unfiled | Remove the Project assignment |

For multipart requests, an absent `project` field means omitted and an explicitly empty field means clear. Reject whitespace-only values, repeated fields, file-valued fields, and invalid types. The literal text `null` is a name, not a clear instruction. MCP uses JSON null to clear.

Return `project` as the current display name or null and `project_created` as a boolean in the team-authorized publishing result. `get_artifact` reports the current authorized Project name and page URL alongside its existing metadata, including when fetching an older version. Omit Project fields entirely from responses to external collaborators, including session-upload results; do not expose internal IDs through a shared result object. Keep raw source downloads unchanged.

Resolve/create the Project and publish the artifact within the existing publishing transaction. Validate permissions, source, and assets before creating a Project; roll back both on any later failure. A failed publish must not leave an empty Project behind. Concurrent publishes of the same normalized name create at most one Project; a subsequent caller may reuse it only if it is accessible to them after the first transaction commits.

If the name belongs to a hidden Project, reject without adding an artifact, creating a duplicate, or revealing its metadata. Use a generic unavailable-name error. Name reservation remains team-wide even for hidden Projects; this can tell a caller that a chosen name cannot be used, but must not reveal the Project or its contents.

Names deliberately have current-name semantics: after a rename, publishing with the old, now-unused name creates a new Project. Do not retain aliases or guess the intended destination. Document this in tool help and report the resolved name and whether a Project was created. An explicit stale name can therefore change placement; omitting `project` when revising preserves a teammate's move.

### Moving

- Add `move_artifact(document_id, project)` to MCP. The Project argument is required and is either an existing accessible name or null for Unfiled. A move does not upload content or create a version.
- Add `list_projects` to MCP, returning only accessible names, Project page URLs, and viewer-filtered counts in the token's team.
- Browser Move to project controls use the same assignment service. List accessible destinations alphabetically, show the current destination, offer Unfiled, and provide New project as an explicit creation flow. Creating a Project from this picker creates and assigns it in one transaction, with artifact editing/team authorization checked before creating anything.
- Unknown or newly renamed destinations fail and ask the caller to refresh/select again. A move never silently creates a Project.
- Moving to the current Project or clearing an already-unfiled artifact is a successful no-op.
- Restrict destinations to the artifact's owning team even when the user belongs to several teams.
- A move changes only assignment. Preserve artifact identity, URL, versions, authorship, sharing, collaborators, comments, and watch state.
- Concurrent moves use the last successfully committed assignment. Return the saved destination; no Undo token, history-based restore, or optimistic concurrency protocol is required.

The artifact-specific session upload endpoint `/api/docs/:slug/versions` remains a content-update operation. Explicitly reject a supplied Project field there, including clear, so external Editors cannot use upload to rearrange the owning team. Narrow its input type as well as validating runtime requests.

## Browsing and interactions

### Shared presentation rules

- Use **View: Folders | Tags** above the documents list. The preference affects that user's display, not anyone else's organization or permissions.
- Resolve a valid `?view=folders|tags` first, then a user-scoped browser cookie, then the Folder default. Persist an explicitly selected valid mode. Validate cookie/query values and use a cookie key scoped to the current user to avoid inheriting another account's choice in a shared browser.
- Apply the chosen mode consistently to each existing team group. Place New project within its team context; a single-team user does not need a team picker.
- Keep Shared with you separate and flat in both modes.
- Preserve existing artifact ordering and columns. A mode change never writes Project assignments.
- Menus must be discoverable on touch and reachable by keyboard, not only visible on hover. Reuse the current table style and mobile scroll behavior.

### Folder view

- Render accessible Project rows above unassigned artifact rows. Show Project name, visible artifact count, open-comment total, and latest publication time across readable artifacts.
- Label the timestamp **Last published**, matching current artifact rows. Renames/moves and inaccessible artifact activity do not bump it. Count open top-level comment threads using the existing definition, rather than replies.
- Show Unfiled only when the user has at least one accessible Project in that team. Hidden Projects must not change the page's empty-state copy or add a divider.
- Open `/p/:id` with a team-aware breadcrumb, the Project name, its artifact table, and a Project menu containing Rename project and Delete project.
- Empty Projects have a useful empty state explaining publishing with the Project name and Move to project. A populated Project with no readable artifacts is hidden/404, not shown with an empty-state placeholder.
- Remember the chosen root view when returning from a Project page. Project pages always show their own artifact list, independent of the root display mode.

### Tag view

- Keep every readable artifact in its existing flat team list, regardless of assignment.
- Add a Project column containing one compact name tag or a neutral dash for Unfiled.
- Clicking a Project tag opens its Project page. The same Move to project action changes the tag and the Folder view assignment.
- Do not render separate Project rows in this mode. Genuinely empty Projects remain reachable through Folder view and the move picker.
- Do not add multi-select tags, personal tagging, or a second assignment table.

### Mutation feedback

Create, rename, move, and delete use server-confirmed results. Disable submission while pending and show a concise success or failure message. No Undo control is shown. If a move removes the last readable artifact and the source Project becomes inaccessible, return to the documents list rather than leaving a stale Project page.

Delete clears every contained artifact's assignment and removes the Project in a single transaction. It removes its tags in Tag view and returns its artifacts to Unfiled in Folder view. Project page links subsequently return 404. Resolve destinations inside the mutation transaction; never retain a dangling assignment or silently fall back to Unfiled. Moving to a deleted name fails. Publishing to that now-unused name creates a new Project under the name-based publishing contract, with a new internal ID and `project_created: true`.

Project mutations do not create notification subscriptions or send digest emails. Keep existing per-artifact comment digests.

## Storage and service design

Add a `projects` table:

| Field | Purpose |
| --- | --- |
| `id` | Opaque stable key for relationships and page URLs |
| `team_id` | Owning team; foreign key |
| `name` | Normalized display name |
| `name_key` | Normalized lookup key; unique together with `team_id` |
| `created_by` | Creator attribution; grants no management privilege |
| `created_at`, `updated_at` | Project creation/metadata timestamps |

Add nullable `documents.project_id` referencing `projects.id`. Index `(team_id, project_id)` for team lists, Project contents, and empty checks. Existing artifacts migrate with null assignment; create no inferred Projects. Generate the next Drizzle migration and its journal/snapshot from the current schema (currently migration 0010 is latest).

Check that artifact and Project teams match in the shared assignment/publish service on every write. Use a foreign key to prevent dangling references and perform Project deletion by explicitly clearing assignments before deleting the Project. Update `deleteTeamCascade` to remove Project rows after documents and before the team. Deleting one artifact preserves its now-empty Project.

Introduce `src/server/services/projects.ts` with shared name normalization, filtered discovery, access checks, create/rename/delete, and assignment operations. Keep authorization inside services used by browser and MCP callers. Return structured errors distinguishing malformed input, missing/inaccessible resources, forbidden artifact edits, and name conflicts without exposing hidden metadata.

Extract reusable artifact list queries/projections from `routes/pages.tsx` into a small service, so Folder view, Tag view, and Project pages share existing artifact permissions, role badges, counts, and ordering. Compute Project aggregates in grouped queries over authorized documents; avoid an additional per-Project query loop or cached global totals. Do not add a generic hierarchy or collection abstraction.

## Routes and integration points

Proposed application endpoints use the existing session/CSRF conventions:

| Endpoint | Behavior |
| --- | --- |
| `GET /p/:id` | Authorized Project page; same 404 for hidden and missing |
| `GET /api/teams/:teamId/projects` | Accessible Projects for the team's list/move picker |
| `POST /api/teams/:teamId/projects` | Create with `{ name }`; optional `document_id` requests atomic create-and-assign after artifact authorization; unique accessible-name conflict is 409 |
| `PATCH /api/projects/:id` | Rename with `{ name }` |
| `DELETE /api/projects/:id` | Dissolve the grouping; retain all artifacts |
| `PATCH /api/docs/:slug/project` | Assign by `{ project: nameOrNull }`, requiring an existing destination |

Browser management routes may use internal page IDs; publishing and agent moves accept Project names. Recheck access at mutation time. All session mutations require CSRF; do not add these endpoints to the bearer exemptions. New agent operations run through the existing MCP bearer authorization and retain the token's team boundary.

Mount a new `routes/projects.tsx` in `app.ts`, explicitly applying session authentication to its Project page and API handlers. Preserve existing route ordering around `/api/publish`, the session-authenticated `/api/*` handlers, and MCP. Use `safeLocalPath` for return navigation.

Add the Project name/assignment capability to the artifact viewer's authorized bootstrap data and its More menu. Add a small documents/Projects client entry and build script for list-page controls; share move-picker logic with the viewer instead of loading the entire viewer bundle on the documents page. Serve the new bundle through the existing static asset route convention.

## Implementation sequence

### 1. Schema and access foundation

- [x] Add `projects`, the document relationship/indexes, and a generated Drizzle migration.
- [x] Implement the Project visibility predicate and filtered metadata projection using current artifact access.
- [x] Add service tests for hidden, mixed-access, empty, cross-team, external, and membership-revocation cases.
- [x] Replace unsafe raw access/document serialization before exposing the new field.

**Done when:** migration preserves existing data and Project names, IDs, counts, and activity are absent from unauthorized responses.

### 2. Project lifecycle and assignment services

- [x] Implement shared name validation, team-scoped uniqueness, create, rename, delete, and single-artifact assignment.
- [x] Enforce artifact editing plus team membership for moves and access to existing destinations.
- [x] Make create-and-assign, publish-and-assign, and delete-and-clear atomic; represent same-destination moves as no-ops.
- [x] Extend document/team deletion integration and test preservation of artifacts, grants, watches, and versions.

**Done when:** all callers can use one service layer and no lifecycle operation crosses a team or changes sharing.

### 3. Publishing and agent support

- [x] Extend `PublishInput`, results, and the existing publish transaction with the `project` contract.
- [x] Extend MCP schema/help and multipart parsing, including omission/null/empty distinctions and invalid repeated fields.
- [x] Reject Project fields in the artifact-specific session version-upload path.
- [x] Implement MCP `list_projects` and `move_artifact`; revalidate the token and its membership on every call.
- [x] Report authorized current Project metadata in publish/get responses and update REST publishing results.
- [x] Update MCP tool inventory tests and README examples, including rename behavior and preserved assignment on republish.

**Done when:** an agent can discover Projects, publish into a named Project, revise without moving it, and move/clear it without creating a version.

### 4. Browser routes and both list modes

- [x] Extract reusable artifact list projections and table components.
- [x] Implement session Project endpoints and `/p/:id`, with access checks and normal CSRF handling.
- [x] Add the mode switch/preference, Folder rows, Unfiled behavior, Tag view, and correct multi-team scoping.
- [x] Add Project pages, empty states, New project, Rename project, and Delete project confirmation.
- [x] Keep Shared with you flat and free of inaccessible Project metadata.

**Done when:** the same artifacts and assignments render correctly in both modes and hidden Projects affect neither output nor totals.

### 5. Moving and release verification

- [x] Add Move to project to artifact rows and the viewer's More menu, including Unfiled and explicit Project creation.
- [x] Add pending/success/error feedback, stale-destination handling, and safe return navigation without Undo.
- [x] Integrate the small list client bundle with the current build/static serving setup.
- [x] Run the acceptance matrix below and update README with both browsing modes and the visibility rule.

**Done when:** UI and agent workflows satisfy the same authorization and assignment contract and the repository checks pass.

Bulk move and drag-and-drop can follow this complete first release, reusing the assignment service. They are not required for the first implementation. Archive, personal collections/favorites, nested Projects, Project-specific sharing, and combined Project comment digests remain future work.

## Validation and acceptance criteria

Use real service/route integration tests for access, mutation, and publishing behavior, plus focused browser flows. Do not add tests that only mirror markup or implementation details.

| Area | Required scenarios |
| --- | --- |
| Migration | Existing documents become Unfiled; retain visibility, ownership, grants, versions, comments, and watches; `foreign_key_check` passes |
| Visibility | Private-only Project hidden from uninvited teammate/admin; invited teammate can see it; mixed Project totals exclude unreadable artifacts; genuinely empty Project visible to members |
| Metadata | Hidden names/IDs/URLs absent from root HTML, Project APIs, move lists, viewer data, nested access objects, exports, and agent responses; direct hidden URLs return 404 |
| Revocation | Losing the last readable artifact hides the populated Project; removing team membership hides even an otherwise readable Project; external grants never grant Project access |
| Names | Normalized names reuse one Project; rename collisions fail; hidden collisions disclose no metadata; identical names across teams remain independent; escaping and encoded names render safely |
| Publish | Cover omitted/name/null on create and republish, multipart equivalents, invalid repeated fields, hidden destinations, rollback after failure, and concurrent same-name creation |
| Rename | Existing assignments/page URL survive; get reports current name; omitted Project on republish preserves assignment; explicit old unused name creates a new Project |
| Move | Same-team effective Editor succeeds; private Viewer/external Editor fails; wrong-team/hidden/missing destination fails; repeated same move is a no-op; no new version, sharing change, or watch change |
| Delete | All contained artifacts become Unfiled, including unreadable ones, without disclosing their count; their content/access survive; stale move destinations fail; publishing to a deleted name explicitly reports creation; team deletion leaves no Project rows |
| Views | Both modes show the same accessible artifact set across root/Project pages; Tag view includes filed artifacts in the flat list; switch does not mutate assignment; multi-team and Shared with you remain scoped |
| Navigation | New empty Project, Project tag link, rename, viewer move, last-readable-artifact move, delete confirmation, and remembered mode behave consistently |
| Accessibility | Move/create/rename/delete and mode selection work using keyboard and touch; focus and errors remain usable; no hover-only controls |

Primary test locations: new `test/server/projects.test.ts` and `e2e/projects.spec.ts`; extend existing `publish.test.ts`, `mcp.test.ts`, `pages.test.ts`, `privateAccess.test.ts`, `migration.test.ts`, and `teams.test.ts` where behavior intersects existing flows.

Run `npm run check`, `npm run build`, and the relevant Playwright suites (`projects`, `private-collaboration`, and the existing publishing/review happy path). Check Folder/Tag views and move controls at a mobile viewport. Verification results for the completed implementation are recorded below.


## Implementation verification — 2026-09-14

All five implementation stages are complete on `feature/projects`.

- `npm run check`: 399 tests passed across 36 files, including typechecking.
- `npm run build`: annotator, viewer, Projects client, and server builds passed.
- `npx drizzle-kit check`: migration consistency passed. Migration 0011 was exercised against test databases; the development/production database was not migrated during this implementation.
- `npx playwright test e2e/projects.spec.ts e2e/private-collaboration.spec.ts e2e/happy-path.spec.ts`: all 34 browser tests passed.
- Independent review traced access predicates, filtered aggregates, lifecycle and publishing transactions, metadata serialization, token boundaries, display preferences, and browser controls. Reported issues were fixed and regression coverage added.
- Desktop Folder/Tag screenshots and a 390px touch viewport were inspected. Table scrolling remains inside its container, the page fits the viewport, dialogs support keyboard/touch, and assignment still succeeds when optional browser storage is unavailable.

Acceptance evidence is in `test/server/projectServices.test.ts` (policy and lifecycle), `test/server/projects.test.ts` (actual routes, hidden metadata, concurrency, permissions, and both views), `test/server/publish.test.ts` and `mcp.test.ts` (publishing/agent contracts and rollback), `migration.test.ts` and `teams.test.ts` (data preservation/cleanup), and `e2e/projects.spec.ts` (end-to-end browsing and management). The simultaneous-publishing route test submits concurrent requests to the application's shared SQLite connection: shared names produce one Project, while a competing caller cannot join a newly private Project.

The first release includes all planned UI and agent workflows. Bulk move, drag-and-drop, archiving, personal collections/favorites, nesting, and independent Project sharing remain the explicitly deferred follow-ups.
