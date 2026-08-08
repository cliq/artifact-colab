# Artifact Colab — MVP Design

**Date:** 2026-08-07
**Status:** Approved design, pre-implementation

## Product

A self-hosted web app where Claude (via MCP) publishes HTML artifacts, teammates sign in
with an email code and comment by highlighting the rendered page, and Claude pulls the
open comments back as structured data to act on them.

**The core loop:** Claude publishes → team highlights and comments → Claude pulls open
threads, revises, republishes → comments re-anchor onto the new version → team verifies
and resolves.

## Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Publishing path | MCP server | Claude publishes directly from a session; slickest workflow |
| Updates | New versions, best-effort re-anchor | Comments survive edits when quoted text still exists; orphan otherwise |
| Comment model | Threads + resolve | Resolution status makes the LLM export actionable (act on open, skip resolved) |
| Export | MCP tool + web export button | Closed loop with Claude Code, plus Markdown/JSON copy for any other LLM |
| Tenancy | Admin-configured domain allowlist | Avoids the public-email-domain problem; safe for MVP |
| Stack | Node/TypeScript, Hono, SQLite (Drizzle), single Docker container | One language end-to-end (annotation code must be TS/JS anyway); shared types for anchors; zero external DB |
| Email | Resend | One POST call, free tier covers MVP scale |
| Rendering | Sandboxed iframe, scripts allowed, network blocked | Artifact JS keeps working; artifact CSS/JS can't touch our app or session |

## Architecture

One Docker container, three faces, one port:

```
┌─────────────────────── Docker container ───────────────────────┐
│  Node/TypeScript app (Hono)                    SQLite (volume)  │
│                                                                 │
│  1. Web app        — sign-in, document list, viewer + comments  │
│  2. REST API       — used by the web app frontend               │
│  3. MCP endpoint   — Streamable HTTP; tools: publish_artifact,  │
│                      get_comments, resolve_comment              │
└─────────────────────────────────────────────────────────────────┘
         ▲ email codes via Resend          ▲ TLS via reverse proxy
```

- **Server:** Hono on Node, TypeScript throughout. Server-rendered pages plus a small
  amount of client JS for the viewer — no SPA framework.
- **Storage:** SQLite via Drizzle ORM on a mounted volume. Artifact HTML stored as text
  in the DB (documents are KB–MB scale; backup = copy one file). 5 MB cap per version.
- **Viewer:** artifact HTML rendered in a sandboxed iframe. The server injects an
  **annotation script** into the artifact HTML at serve time; it paints highlights,
  captures text selections, and talks to the parent page via `postMessage`.
- **Anchoring:** comments store a **text-quote anchor** (exact quoted text +
  prefix/suffix context plus a position hint, à la W3C Web Annotation). On each render
  the annotation script re-locates the quote in the DOM; if not found, the comment
  shows in the sidebar as **orphaned** with its quoted text intact. Relocation also
  runs **server-side** (linkedom) at publish time, cached per version — this powers
  accurate `orphaned` flags in the MCP export and lets `publish_artifact` report
  "N comments were orphaned by this version" back to Claude.
- **MCP auth:** each user generates a **personal access token** from the web UI (shown
  once, stored hashed), used as `Authorization: Bearer` in the MCP client config.
  Publishing and comment-fetching act as that user.

## Data model

| Table | Key fields |
|---|---|
| `users` | id, email, domain, created_at |
| `login_codes` | user email, code (hashed), expires_at (10 min), attempts (max 5) |
| `sessions` | id, user_id, expires_at (30 days) |
| `tokens` | id, user_id, token (hashed), label, created_at — for MCP |
| `documents` | id (URL slug), title, domain, created_by, current_version_id |
| `versions` | id, document_id, number, html, published_at |
| `comments` | id, document_id, parent_id (threading), author_id, body, quoted_text, anchor (JSON: quote/prefix/suffix/position hint), status (open/resolved), created_version_id |
| `comment_anchor_states` | comment_id, version_id, state (anchored/ambiguous/orphaned), start, end — computed server-side per version |

Comments belong to the **document**, not a version — that is what makes re-anchoring
across republishes work.

## Flows

### Sign-in (email code)

1. User enters email → server checks the domain against the allowlist
   (`ALLOWED_DOMAINS=cliqconsulting.com,clientco.com` env/config). Rejected domains get
   the same generic "check your email" response (no domain enumeration).
2. Server generates a 6-digit code, stores it hashed (10-minute expiry, 5 attempts),
   sends it via Resend. Rate limit: 3 codes per email per hour.
3. User enters the code → session cookie (30 days, httpOnly/Secure/SameSite=Lax).
   No passwords anywhere.

### Publish (from Claude via MCP)

1. One-time setup: user generates a personal access token in the web UI and configures
   the MCP server in Claude Code / claude.ai with it.
2. Claude calls `publish_artifact({ title, html, document_id? })`.
   - Without `document_id`: creates a new document (slug ID), version 1.
   - With `document_id`: appends a new version to that document.
3. Tool returns the shareable URL (`https://host/d/<slug>`). Anyone whose email domain
   matches the publisher's domain can open it.

### View & comment

1. Viewer opens `/d/<slug>` (signs in first if needed; 404 if their domain doesn't
   match the document's).
2. Page = header (title, version picker, export button) + sandboxed iframe (latest
   version by default, annotation script injected) + comment sidebar.
3. Selecting text in the artifact shows a "Comment" bubble → sidebar opens a composer →
   saved comment paints a highlight. Clicking a highlight focuses its thread and
   vice-versa.
4. Anyone in the domain can reply and resolve/reopen any thread. Resolved highlights
   fade out of the artifact but remain in a collapsible "Resolved" sidebar section.
   Orphaned comments appear in the sidebar flagged as orphaned, still showing their
   quoted text.
5. No real-time sync: comments load on page load; the sidebar polls every ~30s.

### Export / act on feedback

- **MCP:** `get_comments({ document_id, status? })` returns structured JSON — each
  thread with quoted text, prefix/suffix context, author email, body, replies, status,
  version info, orphaned flag. Claude revises the HTML, republishes with
  `publish_artifact({ document_id, ... })`, and calls `resolve_comment({ comment_id })`
  for items it addressed.
- **Web UI:** an **Export** button offering the same data as Markdown (for pasting into
  any chat) or raw JSON.

## Error handling

- **Anchoring failures are expected behavior, not errors.** If a quote can't be found,
  the comment renders as orphaned in the sidebar. If it matches in multiple places,
  prefix/suffix and position-hint scoring pick a winner (lowest index on ties) and the
  comment is marked **ambiguous** (dotted highlight), never orphaned. Nothing is ever
  deleted by a republish.
- **Auth:** expired/wrong codes get clear messages and a rate-limited resend option;
  expired sessions redirect to sign-in and back to the original URL.
- **MCP tools** return structured tool errors (invalid token, unknown `document_id`,
  cross-domain publish attempt, HTML over the 5 MB cap) so Claude can self-correct.
- **Resend outages:** sign-in fails loudly ("couldn't send email, try again") rather
  than pretending the code went out.

## Security

- Untrusted artifact HTML runs only inside `sandbox="allow-scripts"` iframes — no
  top-navigation and no same-origin, so artifact JS cannot touch cookies, the parent
  DOM, or the API. Iframe content is served from a separate path with its own headers.
  Because the sandboxed frame has an **opaque origin**, the annotation script must be
  **inlined** (not loaded by URL), and the frame CSP allows `'unsafe-inline'` /
  `'unsafe-eval'` scripts — isolation comes from the sandbox, not the CSP. The CSP's
  job is limiting network egress: `default-src 'none'` plus a narrow allowlist of
  common artifact CDNs (Tailwind, jsdelivr, unpkg, Google Fonts) and `img-src data: https:`,
  since most Claude artifacts load libraries from CDNs and would break fully offline.
- `postMessage`: the parent verifies `event.source === iframe.contentWindow`; both
  sides stamp a per-load random capability token (origin checks are impossible against
  an opaque origin, which reports `"null"`). The annotation script accepts only a fixed
  message vocabulary (paint highlights, report selection, scroll-to); no secrets cross
  the channel.
- Codes, sessions, and access tokens are stored hashed. CSRF protection on
  state-changing web routes.
- Every document/comment query is scoped by the session user's domain at the SQL
  level — there is no cross-domain read path.

## Testing

- **Unit:** the anchoring engine is the highest-risk code — pure functions (build
  anchor from a DOM Range; re-locate anchor in HTML) tested against fixture artifacts,
  including republished-with-edits and orphaning cases.
- **API/integration:** auth flow, domain isolation (user A cannot see domain B's
  documents), publish → version bump → comment carry-over, MCP tools end-to-end
  against a real SQLite file.
- **E2E (Playwright):** one happy-path spec — sign in, open doc, highlight, comment,
  reply, resolve, export.

## Out of scope (MVP)

- Real-time collaboration/presence (polling only)
- Notifications of new comments
- Comment editing history
- Roles/permissions beyond domain membership (anyone can resolve anything)
- Artifact types other than a single HTML file (no multi-file; claude.ai React
  artifacts must be exported as HTML first)
- Search
- Mobile-optimized viewer (works, but desktop-first)
- Self-serve domain management (allowlist is a config value)
