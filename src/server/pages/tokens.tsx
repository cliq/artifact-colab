/**
 * Token settings page: list/create/revoke personal access tokens used by
 * MCP, plus a ready-to-paste `claude mcp add` snippet. A freshly created
 * token's plaintext is shown exactly once (it can't be recovered afterward).
 */

import type { FC } from 'hono/jsx';

import type { Token, User } from '../db/schema.js';
import { Layout } from './layout.js';
import { LocalTime } from './localTime.js';

export interface TokenTeamOption {
  id: string;
  name: string;
}

export interface TokensPageProps {
  user: User;
  csrfToken: string;
  tokens: Token[];
  /** Teams the user can scope a new token to (tokens publish into one team). */
  teams: TokenTeamOption[];
  isInstanceAdmin: boolean;
  baseUrl: string;
  justCreated?: { plaintext: string };
  error?: string;
}

// Wires up the [data-copy] buttons; no other JS on this page.
const copyScript = `
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-copy]');
  if (!btn) return;
  var source = document.getElementById(btn.getAttribute('data-copy'));
  if (!source) return;
  navigator.clipboard.writeText(source.textContent.trim()).then(function () {
    var original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = original; }, 1500);
  });
});
`;

export const TokensPage: FC<TokensPageProps> = ({ user, csrfToken, tokens, teams, isInstanceAdmin, baseUrl, justCreated, error }) => {
  const snippet = justCreated
    ? `claude mcp add --transport http --scope user artifact-colab ${baseUrl}/mcp --header "Authorization: Bearer ${justCreated.plaintext}"`
    : null;

  const codexSnippet = justCreated
    ? [
        '[mcp_servers.artifact-colab]',
        `url = "${baseUrl}/mcp"`,
        `http_headers = { "Authorization" = "Bearer ${justCreated.plaintext}" }`,
      ].join('\n')
    : null;

  const opencodeSnippet = justCreated
    ? JSON.stringify(
        {
          mcp: {
            'artifact-colab': {
              type: 'remote',
              url: `${baseUrl}/mcp`,
              headers: { Authorization: `Bearer ${justCreated.plaintext}` },
            },
          },
        },
        null,
        2,
      )
    : null;

  const openclawSnippet = justCreated
    ? JSON.stringify(
        {
          mcp: {
            servers: {
              'artifact-colab': {
                url: `${baseUrl}/mcp`,
                transport: 'streamable-http',
                headers: { Authorization: `Bearer ${justCreated.plaintext}` },
              },
            },
          },
        },
        null,
        2,
      )
    : null;

  return (
    <Layout title="Connect agents - Artifact Colab" user={user} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin}>
      <h1>Connect agents</h1>
      <p class="muted page-intro">
        Personal access tokens let coding agents (Claude Code, Codex, OpenCode, OpenClaw, or any MCP client) publish
        artifacts and read comments as you.
      </p>

      <div class="callout">
        <div class="callout-title">Once connected, publishing is one prompt away.</div>
        <p class="muted">
          Tell your agent <em>“publish this artifact so the team can collaborate”</em> and it replies with a link to
          share. Later, ask it to <em>“check the comments”</em> to pull the feedback back into the session.
        </p>
      </div>

      {justCreated && snippet && (
        <div class="callout callout-accent">
          <div class="callout-title">Token created — copy it now, it won't be shown again.</div>
          <div class="copy-row">
            <code class="token-plaintext" id="new-token">
              {justCreated.plaintext}
            </code>
            <button type="button" class="secondary copy-btn" data-copy="new-token">
              Copy
            </button>
          </div>
          <h3>Connect Claude Code</h3>
          <p class="muted">Run this once in a terminal to add Artifact Colab as an MCP server:</p>
          <div class="copy-row">
            <pre class="snippet" id="mcp-snippet">
              {snippet}
            </pre>
            <button type="button" class="secondary copy-btn" data-copy="mcp-snippet">
              Copy
            </button>
          </div>
          <h3>Connect Codex</h3>
          <p class="muted">
            Add this to <code>~/.codex/config.toml</code> (or use{' '}
            <code>codex mcp add artifact-colab --url {baseUrl}/mcp --bearer-token-env-var YOUR_ENV_VAR</code> if you
            prefer keeping the token in an environment variable):
          </p>
          <div class="copy-row">
            <pre class="snippet" id="codex-snippet">
              {codexSnippet}
            </pre>
            <button type="button" class="secondary copy-btn" data-copy="codex-snippet">
              Copy
            </button>
          </div>
          <h3>Connect OpenCode</h3>
          <p class="muted">
            Merge this into <code>~/.config/opencode/opencode.json</code> (or a project-local{' '}
            <code>opencode.json</code>):
          </p>
          <div class="copy-row">
            <pre class="snippet" id="opencode-snippet">
              {opencodeSnippet}
            </pre>
            <button type="button" class="secondary copy-btn" data-copy="opencode-snippet">
              Copy
            </button>
          </div>
          <h3>Connect OpenClaw</h3>
          <p class="muted">
            Merge this into <code>~/.openclaw/openclaw.json</code>, then verify with{' '}
            <code>openclaw mcp doctor artifact-colab --probe</code>:
          </p>
          <div class="copy-row">
            <pre class="snippet" id="openclaw-snippet">
              {openclawSnippet}
            </pre>
            <button type="button" class="secondary copy-btn" data-copy="openclaw-snippet">
              Copy
            </button>
          </div>
          <p class="muted small">
            For claude.ai, the server must be reachable over public HTTPS. See the{' '}
            <a href="https://github.com/cliq/artifact-colab#readme">README</a> for the tools the agent gets.
          </p>
        </div>
      )}

      <section class="settings-section">
        <h2>Your tokens</h2>
        {tokens.length === 0 ? (
          <p class="muted">No tokens yet — create one below to connect an MCP client.</p>
        ) : (
          <div class="card table-card">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Team</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr>
                    <td>{token.label}</td>
                    <td class="muted">{teams.find((team) => team.id === token.teamId)?.name ?? '—'}</td>
                    <td class="muted"><LocalTime date={token.createdAt} /></td>
                    <td class="muted">{token.lastUsedAt ? <LocalTime date={token.lastUsedAt} /> : 'never'}</td>
                    <td class="cell-actions">
                      <form method="post" action={`/settings/tokens/${token.id}/delete`}>
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <button type="submit" class="secondary danger">
                          Revoke
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section class="settings-section">
        <h2>Create a token</h2>
        {error && <p class="error-message">{error}</p>}
        {teams.length === 0 ? (
          <p class="muted">You're not a member of any team yet — tokens publish into a team, so join one first.</p>
        ) : (
          <form method="post" action="/settings/tokens" class="card form-card">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <div class="form-row">
              <div class="field field-grow">
                <label for="label-input">Label</label>
                <input type="text" id="label-input" name="label" value="MCP token" required />
              </div>
              {teams.length === 1 ? (
                <input type="hidden" name="team_id" value={teams[0]!.id} />
              ) : (
                <div class="field">
                  <label for="team-input">Team</label>
                  <select id="team-input" name="team_id">
                    {teams.map((team) => (
                      <option value={team.id}>{team.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <button type="submit">Create token</button>
            </div>
          </form>
        )}
      </section>

      {!justCreated && (
        <section class="settings-section">
          <h2>Connect Claude Code, Codex, OpenCode, or OpenClaw</h2>
          <p class="muted">
            Create a token above — you'll get a ready-to-paste <code>claude mcp add</code> command plus{' '}
            <code>~/.codex/config.toml</code>, <code>opencode.json</code>, and <code>openclaw.json</code> snippets with
            the token filled in.
          </p>
        </section>
      )}

      <script dangerouslySetInnerHTML={{ __html: copyScript }}></script>
    </Layout>
  );
};
