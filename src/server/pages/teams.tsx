/**
 * Admin surfaces for the teams model: the instance-admin area (/admin — teams,
 * auto-join domains, instance admins) and per-team settings for team admins.
 * The member/invite management markup is shared between the two via
 * `actionBase`, since both post to the same-shaped sub-routes.
 */

import type { FC } from 'hono/jsx';

import type { Team, TeamDomain, TeamInvite, User } from '../db/schema.js';
import { Layout } from './layout.js';
import { LocalTime } from './localTime.js';

export interface MemberRow {
  userId: string;
  email: string;
  role: string;
}

export interface TeamCounts {
  members: number;
  documents: number;
}

const Feedback: FC<{ error?: string; notice?: string }> = ({ error, notice }) => (
  <>
    {error && <p class="error-message">{error}</p>}
    {notice && <p class="muted">{notice}</p>}
  </>
);

/** Members + pending invites management, posting to `${actionBase}/members…` / `${actionBase}/invites…`. */
const MembersSection: FC<{
  csrfToken: string;
  actionBase: string;
  members: MemberRow[];
  invites: TeamInvite[];
}> = ({ csrfToken, actionBase, members, invites }) => (
  <>
    <section class="settings-section">
      <h2>Members</h2>
      <div class="card table-card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr>
                <td>{member.email}</td>
                <td class="muted">{member.role === 'admin' ? 'Team admin' : 'Member'}</td>
                <td class="cell-actions">
                  <form method="post" action={`${actionBase}/members/${member.userId}/role`}>
                    <input type="hidden" name="_csrf" value={csrfToken} />
                    <input type="hidden" name="role" value={member.role === 'admin' ? 'member' : 'admin'} />
                    <button type="submit" class="secondary">
                      {member.role === 'admin' ? 'Demote to member' : 'Make team admin'}
                    </button>
                  </form>
                  <form method="post" action={`${actionBase}/members/${member.userId}/remove`}>
                    <input type="hidden" name="_csrf" value={csrfToken} />
                    <button type="submit" class="secondary danger">
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form method="post" action={`${actionBase}/members`} class="card form-card" style="margin-top: 1rem">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <div class="form-row">
          <div class="field field-grow">
            <label for="invite-email">Invite by email</label>
            <input type="email" id="invite-email" name="email" placeholder="teammate@anywhere.com" required />
          </div>
          <div class="field">
            <label for="invite-role">Role</label>
            <select id="invite-role" name="role">
              <option value="member">Member</option>
              <option value="admin">Team admin</option>
            </select>
          </div>
          <button type="submit">Invite</button>
        </div>
        <p class="muted small">
          If they already have an account they join immediately; otherwise they get an email and join by signing in.
        </p>
      </form>
    </section>

    {invites.length > 0 && (
      <section class="settings-section">
        <h2>Pending invites</h2>
        <div class="card table-card">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Invited</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr>
                  <td>{invite.email}</td>
                  <td class="muted">{invite.role === 'admin' ? 'Team admin' : 'Member'}</td>
                  <td class="muted"><LocalTime date={invite.createdAt} /></td>
                  <td class="cell-actions">
                    <form method="post" action={`${actionBase}/invites/${invite.id}/cancel`}>
                      <input type="hidden" name="_csrf" value={csrfToken} />
                      <button type="submit" class="secondary danger">
                        Cancel
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    )}
  </>
);

const RenameSection: FC<{ csrfToken: string; action: string; team: Team }> = ({ csrfToken, action, team }) => (
  <section class="settings-section">
    <h2>Rename team</h2>
    <form method="post" action={action} class="card form-card">
      <input type="hidden" name="_csrf" value={csrfToken} />
      <div class="form-row">
        <div class="field field-grow">
          <label for="team-name">Name</label>
          <input type="text" id="team-name" name="name" value={team.name} required />
        </div>
        <button type="submit">Rename</button>
      </div>
    </form>
  </section>
);

// ---------------------------------------------------------------------------
// Instance admin: /admin

export interface AdminTeamListRow {
  team: Team;
  memberCount: number;
  domains: string[];
}

export interface InstanceAdminRow {
  user: User;
  /** Listed in INSTANCE_ADMIN_EMAILS — renders as locked (cannot be demoted). */
  envListed: boolean;
}

export const AdminPage: FC<{
  user: User;
  csrfToken: string;
  teams: AdminTeamListRow[];
  admins: InstanceAdminRow[];
  /** Env-listed admin emails without an account yet — shown so the list is complete. */
  pendingEnvAdmins: string[];
  error?: string;
  notice?: string;
}> = ({ user, csrfToken, teams, admins, pendingEnvAdmins, error, notice }) => (
  <Layout title="Admin - Artifact Colab" user={user} csrfToken={csrfToken} isInstanceAdmin>
    <h1>Admin</h1>
    <Feedback error={error} notice={notice} />

    <section class="settings-section">
      <h2>Teams</h2>
      {teams.length === 0 ? (
        <p class="muted">No teams yet — create the first one below.</p>
      ) : (
        <div class="card table-card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Members</th>
                <th>Auto-join domains</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((row) => (
                <tr>
                  <td>
                    <a href={`/admin/teams/${row.team.id}`}>{row.team.name}</a>
                  </td>
                  <td>{row.memberCount}</td>
                  <td class="muted">{row.domains.length > 0 ? row.domains.join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form method="post" action="/admin/teams" class="card form-card" style="margin-top: 1rem">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <div class="form-row">
          <div class="field field-grow">
            <label for="new-team-name">Create a team</label>
            <input type="text" id="new-team-name" name="name" placeholder="Team name" required />
          </div>
          <button type="submit">Create</button>
        </div>
      </form>
    </section>

    <section class="settings-section">
      <h2>Instance admins</h2>
      <div class="card table-card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {admins.map((row) => (
              <tr>
                <td>{row.user.email}</td>
                <td class="cell-actions">
                  {row.envListed ? (
                    <span class="locked-note" title="Listed in INSTANCE_ADMIN_EMAILS">
                      env-listed
                    </span>
                  ) : (
                    <form method="post" action={`/admin/admins/${row.user.id}/demote`}>
                      <input type="hidden" name="_csrf" value={csrfToken} />
                      <button type="submit" class="secondary danger">
                        Demote
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {pendingEnvAdmins.map((email) => (
              <tr>
                <td class="muted">{email} (hasn't signed in yet)</td>
                <td class="cell-actions">
                  <span class="locked-note" title="Listed in INSTANCE_ADMIN_EMAILS">
                    env-listed
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form method="post" action="/admin/admins" class="card form-card" style="margin-top: 1rem">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <div class="form-row">
          <div class="field field-grow">
            <label for="admin-email">Promote by email</label>
            <input type="email" id="admin-email" name="email" placeholder="person@company.com" required />
          </div>
          <button type="submit">Promote</button>
        </div>
        <p class="muted small">The email must already have an account.</p>
      </form>
    </section>
  </Layout>
);

export const AdminTeamPage: FC<{
  user: User;
  csrfToken: string;
  team: Team;
  domains: TeamDomain[];
  members: MemberRow[];
  invites: TeamInvite[];
  error?: string;
  notice?: string;
}> = ({ user, csrfToken, team, domains, members, invites, error, notice }) => {
  const base = `/admin/teams/${team.id}`;
  return (
    <Layout title={`${team.name} - Admin - Artifact Colab`} user={user} csrfToken={csrfToken} isInstanceAdmin>
      <p class="muted">
        <a href="/admin">← All teams</a>
      </p>
      <h1>{team.name}</h1>
      <Feedback error={error} notice={notice} />

      <RenameSection csrfToken={csrfToken} action={`${base}/rename`} team={team} />

      <section class="settings-section">
        <h2>Auto-join domains</h2>
        <p class="muted">Anyone signing in with an email on these domains automatically joins this team.</p>
        {domains.length > 0 && (
          <div class="card table-card">
            <table>
              <tbody>
                {domains.map((row) => (
                  <tr>
                    <td>{row.domain}</td>
                    <td class="cell-actions">
                      <form method="post" action={`${base}/domains/remove`}>
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <input type="hidden" name="domain" value={row.domain} />
                        <button type="submit" class="secondary danger">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form method="post" action={`${base}/domains`} class="card form-card" style="margin-top: 1rem">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <div class="form-row">
            <div class="field field-grow">
              <label for="new-domain">Attach a domain</label>
              <input type="text" id="new-domain" name="domain" placeholder="company.com" required />
            </div>
            <button type="submit">Attach</button>
          </div>
        </form>
      </section>

      <MembersSection csrfToken={csrfToken} actionBase={base} members={members} invites={invites} />

      <section class="settings-section">
        <h2>Danger zone</h2>
        <p class="muted">
          <a href={`${base}/delete`}>Delete this team…</a>
        </p>
      </section>
    </Layout>
  );
};

export const AdminTeamDeletePage: FC<{
  user: User;
  csrfToken: string;
  team: Team;
  counts: TeamCounts;
}> = ({ user, csrfToken, team, counts }) => (
  <Layout title={`Delete ${team.name} - Admin - Artifact Colab`} user={user} csrfToken={csrfToken} isInstanceAdmin>
    <p class="muted">
      <a href={`/admin/teams/${team.id}`}>← Back to {team.name}</a>
    </p>
    <h1>Delete {team.name}?</h1>
    <p>
      This permanently deletes the team, its {counts.documents} document{counts.documents === 1 ? '' : 's'} (with all
      versions, comments, and uploaded assets), {counts.members} membership{counts.members === 1 ? '' : 's'}, its
      auto-join domains, pending invites, and every token scoped to it. There is no undo.
    </p>
    <form method="post" action={`/admin/teams/${team.id}/delete`}>
      <input type="hidden" name="_csrf" value={csrfToken} />
      <button type="submit" class="danger">
        Delete {team.name} permanently
      </button>
    </form>
  </Layout>
);

// ---------------------------------------------------------------------------
// Team admin: /teams/:id/settings

export const TeamSettingsPage: FC<{
  user: User;
  csrfToken: string;
  isInstanceAdmin: boolean;
  team: Team;
  members: MemberRow[];
  invites: TeamInvite[];
  error?: string;
  notice?: string;
}> = ({ user, csrfToken, isInstanceAdmin, team, members, invites, error, notice }) => {
  const base = `/teams/${team.id}/settings`;
  return (
    <Layout title={`${team.name} settings - Artifact Colab`} user={user} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin}>
      <p class="muted">
        <a href="/">← Documents</a>
      </p>
      <h1>{team.name} settings</h1>
      <Feedback error={error} notice={notice} />

      <RenameSection csrfToken={csrfToken} action={`${base}/rename`} team={team} />
      <MembersSection csrfToken={csrfToken} actionBase={base} members={members} invites={invites} />

      <p class="muted small">Auto-join domains are managed by instance admins.</p>
    </Layout>
  );
};
