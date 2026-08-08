/**
 * Document list page: every document in the signed-in user's teams, with
 * version and open-comment counts. Grouped by team when the user belongs to
 * more than one; flat otherwise. Shown at `GET /`.
 */

import type { FC } from 'hono/jsx';

import type { User } from '../db/schema.js';
import { Layout } from './layout.js';
import { LocalTime } from './localTime.js';

export interface DocumentListRow {
  id: string;
  title: string;
  versionCount: number;
  openCommentCount: number;
  lastPublishedAt: Date | null;
}

export interface TeamDocumentsGroup {
  teamId: string;
  teamName: string;
  isTeamAdmin: boolean;
  documents: DocumentListRow[];
}

/** First-run team wizard, shown instead of the zero-team empty state when self sign-up is on. */
export interface TeamWizardProps {
  /** The auto-join domain this user may claim, or null → the choice is omitted and the team is invite-only. */
  claimableDomain: string | null;
  error?: string;
}

export interface DocumentsPageProps {
  user: User;
  csrfToken: string;
  groups: TeamDocumentsGroup[];
  isInstanceAdmin: boolean;
  wizard?: TeamWizardProps;
}

const DocumentsTable: FC<{ documents: DocumentListRow[] }> = ({ documents }) => (
  <table>
    <thead>
      <tr>
        <th>Title</th>
        <th>Versions</th>
        <th>Open comments</th>
        <th>Last published</th>
      </tr>
    </thead>
    <tbody>
      {documents.map((doc) => (
        <tr>
          <td>
            <a href={`/d/${doc.id}`}>{doc.title}</a>
          </td>
          <td>{doc.versionCount}</td>
          <td>{doc.openCommentCount}</td>
          <td class="muted">{doc.lastPublishedAt ? <LocalTime date={doc.lastPublishedAt} /> : '—'}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const EmptyTeamNote: FC = () => (
  <div class="empty-state">
    <p>Nothing published yet.</p>
    <p>
      Documents show up here as soon as a team member publishes an artifact from an agent via MCP. Head to{' '}
      <a href="/settings/tokens">Connect agents</a> to set up MCP access.
    </p>
  </div>
);

const TeamWizard: FC<{ csrfToken: string; wizard: TeamWizardProps }> = ({ csrfToken, wizard }) => (
  <form method="post" action="/teams" class="card form-card" id="team-wizard">
    <h2>Create your team</h2>
    {wizard.error && <p class="error-message">{wizard.error}</p>}
    <input type="hidden" name="_csrf" value={csrfToken} />
    <div class="field">
      <label for="wizard-team-name">Team name</label>
      <input type="text" id="wizard-team-name" name="name" placeholder="Team name" required autofocus />
    </div>
    {wizard.claimableDomain && (
      <fieldset class="field">
        <legend>Who can join?</legend>
        <label>
          <input type="radio" name="claimDomain" value="true" />
          Anyone @{wizard.claimableDomain} joins automatically
        </label>
        <label>
          <input type="radio" name="claimDomain" value="false" checked />
          Invite-only
        </label>
      </fieldset>
    )}
    <button type="submit">Create team</button>
    <p class="muted small">You'll be the team admin — you can invite people and rename the team from team settings.</p>
  </form>
);

export const DocumentsPage: FC<DocumentsPageProps> = ({ user, csrfToken, groups, isInstanceAdmin, wizard }) => {
  return (
    <Layout title="Documents - Artifact Colab" user={user} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin}>
      {groups.length === 0 ? (
        <>
          <h1>{wizard ? 'Welcome' : 'Documents'}</h1>
          {wizard ? (
            <TeamWizard csrfToken={csrfToken} wizard={wizard} />
          ) : (
            <div class="empty-state">
              <p>You're not a member of any team yet.</p>
              <p>
                {isInstanceAdmin ? (
                  <>
                    Create a team and add yourself as a member from the <a href="/admin">admin area</a>.
                  </>
                ) : (
                  <>Ask a team admin to invite you, then sign in again.</>
                )}
              </p>
            </div>
          )}
        </>
      ) : groups.length === 1 ? (
        <>
          <div class="page-title-row">
            <h1>Documents</h1>
            {groups[0]!.isTeamAdmin && (
              <a class="muted" href={`/teams/${groups[0]!.teamId}/settings`}>
                Team settings
              </a>
            )}
          </div>
          {groups[0]!.documents.length === 0 ? <EmptyTeamNote /> : <DocumentsTable documents={groups[0]!.documents} />}
        </>
      ) : (
        <>
          <h1>Documents</h1>
          {groups.map((group) => (
            <section class="team-group">
              <div class="page-title-row">
                <h2>{group.teamName}</h2>
                {group.isTeamAdmin && (
                  <a class="muted" href={`/teams/${group.teamId}/settings`}>
                    Team settings
                  </a>
                )}
              </div>
              {group.documents.length === 0 ? <EmptyTeamNote /> : <DocumentsTable documents={group.documents} />}
            </section>
          ))}
        </>
      )}
    </Layout>
  );
};
