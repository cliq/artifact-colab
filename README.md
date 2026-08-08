# Artifact Colab

A self-hosted space where your team reviews what Claude builds.

Claude publishes HTML artifacts straight from a session via MCP. Teammates open them in the browser, highlight
text, and leave comments — like a Google Doc, but for artifacts. Claude then pulls the open threads back through
MCP, revises, and republishes; comments re-anchor onto the new version so the team can verify and resolve.

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

   `INSTANCE_ADMIN_EMAILS` bootstraps who can administer the instance. Teams are the tenancy boundary: documents
   belong to a team and only its members see them. Instance admins create teams at `/admin`, attach email domains
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

## Good to know

- Connected agents get four MCP tools: `publish_artifact`, `get_artifact`, `get_comments`, and `resolve_comment` —
  enough to publish a page, fetch it back, read the team's feedback, and close out addressed threads.
- You automatically watch every artifact you publish or comment on (the Watch button on the viewer opts any
  artifact in or out). Five minutes after a watched artifact's discussion goes quiet, everyone watching gets one
  email with all the comments they haven't seen — never their own.
- Artifacts run inside a sandboxed iframe; their scripts can't touch the app or your session.
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

