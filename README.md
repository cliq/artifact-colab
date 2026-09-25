# Artifact Colab

A self-hosted space where your team reviews what Claude builds.

Claude publishes HTML artifacts straight from a session via MCP. Teammates open them in the browser, highlight
text, and leave comments — like a Google Doc, but for artifacts. Claude then pulls the open threads back through
MCP, revises, and republishes; comments re-anchor onto the new version so the team can verify and resolve.

## Projects

Projects organize a team's artifacts without changing who can open or edit them. Each artifact is either assigned to one Project or **Unfiled**. In Folder view, click a Project row to expand or collapse its artifacts directly on the documents screen. Multiple Projects can stay open, with expansion remembered per account in the current browser tab. The settings icon after Last published offers Rename and Delete whether the Project is expanded or collapsed. Tag view keeps the flat artifact list and shows each assignment as a Project tag; clicking a tag reveals that Project in Folder view. The view choice is personal and is remembered in the browser.

Every data column in Tag view is sortable: Artifact, Sharing, Versions, Open comments, Last published, and Project. Click a header to sort ascending, then click again to reverse it. Counts sort numerically and publication times chronologically; Unfiled and missing dates stay last in either direction. Sorting applies across the team lists and is remembered per account in the browser. The default is most recently published first.

Project visibility follows artifact access. An empty Project is visible to all current team members; a populated Project appears only when the member can read at least one artifact in it, and its counts include only artifacts that member can read. Externally shared artifacts remain in **Shared with you** without exposing their owning team's Project metadata.

Team members can create Projects and can rename or delete any Project they can access. Deleting a Project returns all of its artifacts to Unfiled while preserving their versions, comments, sharing, and URLs. Moving an artifact requires edit permission and changes only its current assignment.

Agents can pass `project: "Website launch"` to `publish_artifact` to reuse an accessible Project or create it when the name is unused. Passing JSON `null` clears the assignment; omitting `project` on a revision preserves the assignment at publish time. The multipart `/api/publish` endpoint uses an absent `project` field to preserve and an empty field to clear. Project names use current-name semantics: publishing with an old name after a rename creates a new Project if that name is now unused. `list_projects` discovers visible destinations, while `move_artifact` moves to an existing Project name or Unfiled without publishing a new version.

## Private collaboration

Choose **Private** in an artifact's Share panel to limit access to you and the people you invite. Enter email addresses (an optional leading `@` is accepted), choose Viewer or Editor for each, and send invitations. Each recipient signs in with their invited email and explicitly accepts the link. Invitations expire after seven days; the owner can resend, change roles, cancel invitations, or remove access in Share. Delivery failures appear individually so successful invitations need not be sent again.

Viewers can read versions, compare changes, export, and watch comments. **Request edit permission** emails the owner a link to the Share panel; the owner decides whether to grant Editor access. Requests have a daily cooldown. Editors can comment, reply, react, resolve threads, and use **Upload new version** with HTML or Markdown and optional assets. Artifact invitations never add team membership, and external or teamless Editors can upload directly without creating a team or token. Team-scoped REST/MCP tokens remain restricted to their own team.

Accepted artifacts appear in team lists or **Shared with you**, independently of watching. Explicit grants persist across visibility changes; Team/Public access may give someone broader rights. Private restores the assigned roles. Only the owner manages collaborators or changes a private artifact's visibility. If the owner leaves the owning team, private access and invitations are suspended until their membership is restored. New artifacts still default to Team visibility.

## Setup

Requires [Docker](https://docs.docker.com/get-docker/), a [Resend](https://resend.com) API key for sign-in emails,
and a host to run it on.

1. Create a `.env` file next to `docker-compose.yml`:

   ```sh
   RESEND_API_KEY=re_...
   EMAIL_FROM=colab@yourcompany.com
   INSTANCE_ADMIN_EMAILS=you@yourcompany.com
   BASE_URL=https://colab.yourcompany.com
   ```

   `INSTANCE_ADMIN_EMAILS` bootstraps who can administer the instance. Documents belong to a team; visibility and
   explicit artifact invitations determine who can access them. Instance admins create teams at `/admin`, attach email domains
   (anyone signing in from an attached domain auto-joins that team), and appoint team admins, who invite and
   manage members — including guests from other domains. See `.env.example` for the full list of options.

   By default only people who are invited, auto-joined by domain, or listed as instance admins can sign in. Set
   `SELF_SIGNUP=true` to let anyone sign up and create their own team: new users with no team get a first-run
   wizard that names the team and — when their email domain isn't a free-mail provider and is unclaimed — can
   attach it for auto-join. The creator becomes that team's admin.

2. Start it:

   ```sh
   docker compose up -d
   ```

   The server listens on port 3000 and keeps its SQLite database on the `artifact-colab-data` volume. For anything
   beyond localhost, put it behind a reverse proxy that terminates TLS and set `BASE_URL` to the `https://` URL.
   A ready-made Caddy setup is included — add two lines to `.env`:

   ```sh
   COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.prod.yml
   DOMAIN=colab.yourcompany.com
   ```

   and `docker compose up -d` will also run Caddy on ports 80/443, obtain Let's Encrypt certificates for `DOMAIN`
   automatically, and stop publishing the app port on the host. `deploy/setup.sh` bootstraps a fresh Debian host
   (installs Docker, starts the stack) and `deploy/update.sh` redeploys after changes.

3. Sign in at your `BASE_URL` with a work email — a 6-digit code arrives by email, no passwords.

4. Connect your agent: go to **Settings → Connect agents** in the top nav, create a token, and paste the
   `claude mcp add` command (or Codex/OpenCode config snippet) it gives you into a terminal. Then tell the agent to
   "publish this artifact so the team can collaborate" and the review loop is live. (claude.ai needs the server
   reachable over public HTTPS; Claude Code works against localhost too.)

## Local development

```sh
npm install
npm run build    # bundles the annotator + viewer, compiles the server
npm run dev      # runs the server with live reload
npm run check    # typecheck + unit tests
npm run e2e      # Playwright end-to-end tests
```

Two dev-only env vars avoid real email: `DEV_LOGIN_CODE_FILE=<path>` writes sign-in codes to a file, and
`DEV_LOGIN_CODE=123456` accepts that fixed code for any email that passes the sign-in gate. Never set either in
production — the server refuses to start if `DEV_LOGIN_CODE` is set while `NODE_ENV=production`.

### Local demo data

Run `npm run seed:local` to populate the local SQLite database with two demo teams, nine Projects, and 23 artifacts. The seed loads `.env`, uses `DATABASE_PATH` (default `data/app.db`), and adds the first `INSTANCE_ADMIN_EMAILS` account to both demo teams. To choose another account, run `SEED_USER_EMAIL=you@example.com npm run seed:local`. With neither setting, Alex is the default demo account. Existing accounts, teams, and artifacts are preserved; rerunning skips existing demo artifacts, including any moves, revisions, or comments you have made while testing.

Refresh `http://localhost:3000/?view=folders` or `http://localhost:3000/?view=tags` after seeding. The examples include an empty Project, three Unfiled artifacts, a long Project name, the same Project name in different teams, Team/Public/Private sharing, one to three versions per artifact, and open and resolved comments. **Leadership planning** contains only Maya's private artifacts, so it is hidden from other accounts; **Website launch** contains three team-readable artifacts and one private artifact that only Maya sees. Your selected account also has Editor access to the private mobile handoff and Viewer access to the private customer advisory notes.

Use the same configured `DEV_LOGIN_CODE` for these demo emails, or read their sign-in codes from `DEV_LOGIN_CODE_FILE`:

| Account | What to try |
| --- | --- |
| `alex@example.test` | Product Studio; team administration and shared artifacts |
| `maya@example.test` | Both teams; private artifacts and Leadership planning |
| `sam@example.test` | Both teams; a different mix of owned and shared artifacts |
| `riley@example.test` | External guest; two artifacts under Shared with you, one Editor and one Viewer, with no Project metadata |

## Good to know

- Connected agents get nine MCP tools: `publish_artifact`, `get_artifact`, `list_projects`, `move_artifact`,
  `get_comments`, `add_comment`, `edit_comment`, `resolve_comment`, and `delete_artifact` — enough to publish and
  organize a page, fetch it back, read the team's feedback, join
  the discussion (open a thread on a quoted passage or reply to one), fix their own comments, close out addressed
  threads, and clean up.
- Comments an agent posts through MCP are attributed to the token's owner with an "agent" badge naming the access
  token, so a review from Claude Code and one from a second reader model stay distinguishable in the sidebar and in
  the digest emails. Agents can edit only the comments they posted this way, never what their owner typed.
- Comment bodies are Markdown (GFM), whether typed in the sidebar or posted by an agent. Raw HTML stays literal
  text and images show as links.
- You automatically watch every artifact you publish or comment on (the Watch button on the viewer opts any
  artifact in or out). Five minutes after a watched artifact's discussion goes quiet, everyone watching gets one
  email with all the comments they haven't seen — never their own.
- Type `@` in a comment to tag a teammate from the picker. A tagged person starts watching the artifact right away
  (even if they had opted out) and the comment reaches them in the next digest, flagged as a mention. Agents can tag
  people too, by writing `@their@email` in the body of an `add_comment` call. Only people who can open the artifact
  can be tagged: on a Private artifact, only its active owner and accepted collaborators are eligible.
- Artifacts run inside a sandboxed iframe; their scripts can't touch the app or your session. The sandbox has no
  Web Storage of its own, so the viewer stands in: an artifact's `localStorage`/`sessionStorage` is kept per
  document in your browser and comes back on the next visit, like it would on claude.ai.
- Large artifacts don't have to squeeze through an MCP tool call: `POST /api/publish` accepts a multipart upload
  (HTML file + image assets) with the same bearer token, so Claude can `curl` big files straight from disk. The
  `publish_artifact` tool description includes the exact command.
- Backups are one SQLite file. The runtime image has no `sqlite3` CLI, so use the bundled driver's online-backup API
  (safe while the app is running):
  `docker compose exec artifact-colab node -e "require('better-sqlite3')('/data/app.db').backup('/data/backup.db').then(() => console.log('done'))"`
  then copy it out with `docker compose cp artifact-colab:/data/backup.db .`.
- Agents can publish Markdown instead of HTML (`markdown` in place of `html`, in the MCP tool or the upload
  endpoint): the server renders it to a clean page and hands the original Markdown source back to the agent when
  it fetches the artifact for revision.
- Comments anchor to visible text, documents are single HTML files (plus uploaded image assets), and the sidebar
  polls rather than syncing in real time.

## License

[MIT](LICENSE) © Cliq Consulting LLC
