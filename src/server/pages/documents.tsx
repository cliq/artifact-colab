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
  /** The creator's display name, falling back to their email. */
  ownerName: string;
  ownerEmail: string | null;
  /** Private documents are listed only for their creator. */
  visibility: 'private' | 'team' | 'public';
  versionCount: number;
  openCommentCount: number;
  lastPublishedAt: Date | null;
}

/** Column label per share level; `title` explains who the link opens for. */
const shareLabels: Record<DocumentListRow['visibility'], { label: string; title: string }> = {
  private: { label: 'Private', title: 'Only you can open this artifact' },
  team: { label: 'Team', title: 'Only members of the team can open this artifact' },
  public: { label: 'Public', title: 'Anyone signed in with the link can open this artifact' },
};

const ShareBadge: FC<{ visibility: DocumentListRow['visibility'] }> = ({ visibility }) => {
  const share = shareLabels[visibility];
  return (
    <span class={`share-badge share-badge-${visibility}`} title={share.title}>
      {share.label}
    </span>
  );
};

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
  /** Public documents outside the user's teams that they interacted with (see `sharedWithUserRows`). */
  shared: DocumentListRow[];
  isInstanceAdmin: boolean;
  wizard?: TeamWizardProps;
}

const DocumentsTable: FC<{ documents: DocumentListRow[] }> = ({ documents }) => (
  <div class="documents-table-scroll">
  <table class="documents-table">
    <thead>
      <tr>
        <th>Artifact</th>
        <th>Sharing</th>
        <th>Versions</th>
        <th>Open comments</th>
        <th>Last published</th>
      </tr>
    </thead>
    <tbody>
      {documents.map((doc) => (
        <tr>
          <td>
            <a class="document-title" href={`/d/${doc.id}`}>{doc.title}</a>
            <div class="document-owner muted" title={doc.ownerEmail ?? undefined}>
              {doc.ownerName}
            </div>
          </td>
          <td>
            <ShareBadge visibility={doc.visibility} />
          </td>
          <td>{doc.versionCount}</td>
          <td>{doc.openCommentCount}</td>
          <td class="muted">{doc.lastPublishedAt ? <LocalTime date={doc.lastPublishedAt} split /> : '—'}</td>
        </tr>
      ))}
    </tbody>
  </table>
  </div>
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

/** Public documents from other teams the user interacted with; shown after their own teams' groups. */
const SharedSection: FC<{ documents: DocumentListRow[] }> = ({ documents }) => (
  <section class="team-group">
    <div class="page-title-row">
      <h2>Shared with you</h2>
    </div>
    <DocumentsTable documents={documents} />
  </section>
);

export const DocumentsPage: FC<DocumentsPageProps> = ({ user, csrfToken, groups, shared, isInstanceAdmin, wizard }) => {
  return (
    <Layout mainClass="documents-page" title="Documents - Artifact Colab" user={user} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin}>
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
          {shared.length > 0 && <SharedSection documents={shared} />}
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
          {shared.length > 0 && <SharedSection documents={shared} />}
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
          {shared.length > 0 && <SharedSection documents={shared} />}
        </>
      )}
    </Layout>
  );
};
