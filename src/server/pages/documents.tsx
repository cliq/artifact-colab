/** Browser document list with personal Folder and Tag presentations. */

import type { FC } from 'hono/jsx';

import type { User } from '../db/schema.js';
import type { DocumentListRow, DocumentsView, ProjectSummary, TeamDocumentsGroup } from '../services/documentLists.js';
import { Layout } from './layout.js';
import { LocalTime } from './localTime.js';

export type { DocumentListRow, DocumentsView, TeamDocumentsGroup } from '../services/documentLists.js';

const shareLabels: Record<DocumentListRow['visibility'], { label: string; title: string }> = {
  private: { label: 'Private', title: 'Only the owner and invited people can open this artifact' },
  team: { label: 'Team', title: 'Team members and invited people can open this artifact' },
  public: { label: 'Public', title: 'Anyone signed in with the link can open this artifact' },
};

const ShareBadge: FC<{ visibility: DocumentListRow['visibility']; effectiveRole?: DocumentListRow['effectiveRole'] }> = ({ visibility, effectiveRole }) => {
  const share = shareLabels[visibility];
  const role = effectiveRole && effectiveRole !== 'owner' ? ` · Your role: ${effectiveRole}` : '';
  return <span class={`share-badge share-badge-${visibility}`} title={`${share.title}${role}`}>{share.label}</span>;
};

export interface TeamWizardProps {
  claimableDomain: string | null;
  error?: string;
}

export interface DocumentsPageProps {
  user: User;
  csrfToken: string;
  groups: TeamDocumentsGroup[];
  shared: DocumentListRow[];
  isInstanceAdmin: boolean;
  view: DocumentsView;
  wizard?: TeamWizardProps;
}

export interface DocumentsTableProps {
  documents: DocumentListRow[];
  showProjects?: boolean;
  /** Shared-with-you rows remain free of team Project controls. */
  allowMoves?: boolean;
}

/** Reused by the root list and an individual Project page. */
export const DocumentsTable: FC<DocumentsTableProps> = ({ documents, showProjects = false, allowMoves = true }) => (
  <div class="documents-table-scroll">
    <table class={`documents-table${showProjects ? ' documents-table-tags' : ''}`}>
      <thead><tr>
        <th>Artifact</th><th>Sharing</th><th>Versions</th><th>Open comments</th><th>Last published</th>
        {showProjects && <th>Project</th>}
        {allowMoves && <th><span class="visually-hidden">Actions</span></th>}
      </tr></thead>
      <tbody>{documents.map((doc) => <tr>
        <td>
          <a class="document-title" href={`/d/${doc.id}`}>{doc.title}</a>
          <div class="document-owner muted" title={doc.ownerEmail ?? undefined}>{doc.ownerName}</div>
        </td>
        <td><ShareBadge visibility={doc.visibility} effectiveRole={doc.effectiveRole} /></td>
        <td>{doc.versionCount}</td><td>{doc.openCommentCount}</td>
        <td class="muted">{doc.lastPublishedAt ? <LocalTime date={doc.lastPublishedAt} split /> : '—'}</td>
        {showProjects && <td>{doc.project ? <a class="project-tag" href={`/p/${doc.project.id}`}>{doc.project.name}</a> : <span class="muted" aria-label="Unfiled">—</span>}</td>}
        {allowMoves && <td class="document-project-action">{doc.canMoveProject && <button
          type="button" class="secondary compact-button" data-move-to-project data-document-id={doc.id}
          data-team-id={doc.teamId} data-project-name={doc.project?.name ?? ''}
        >Move</button>}</td>}
      </tr>)}</tbody>
    </table>
  </div>
);

const ProjectsTable: FC<{ projects: ProjectSummary[] }> = ({ projects }) => <div class="documents-table-scroll project-table-wrap">
  <table class="documents-table projects-table">
    <thead><tr><th>Project</th><th>Artifacts</th><th>Open comments</th><th>Last published</th></tr></thead>
    <tbody>{projects.map((project) => <tr class="project-row">
      <td><a class="document-title" href={`/p/${project.id}`}>{project.name}</a></td>
      <td>{project.artifactCount}</td><td>{project.openCommentCount}</td>
      <td class="muted">{project.lastPublishedAt ? <LocalTime date={project.lastPublishedAt} split /> : '—'}</td>
    </tr>)}</tbody>
  </table>
</div>;

const EmptyTeamNote: FC = () => <div class="empty-state">
  <p>Nothing published yet.</p>
  <p>Documents show up here as soon as a team member publishes an artifact from an agent via MCP. Head to{' '}<a href="/settings/tokens">Connect agents</a> to set up MCP access.</p>
</div>;

const TeamWizard: FC<{ csrfToken: string; wizard: TeamWizardProps }> = ({ csrfToken, wizard }) => <form method="post" action="/teams" class="card form-card" id="team-wizard">
  <h2>Create your team</h2>
  {wizard.error && <p class="error-message">{wizard.error}</p>}
  <input type="hidden" name="_csrf" value={csrfToken} />
  <div class="field"><label for="wizard-team-name">Team name</label><input type="text" id="wizard-team-name" name="name" placeholder="Team name" required autofocus /></div>
  {wizard.claimableDomain && <fieldset class="field"><legend>Who can join?</legend>
    <label><input type="radio" name="claimDomain" value="true" />Anyone @{wizard.claimableDomain} joins automatically</label>
    <label><input type="radio" name="claimDomain" value="false" checked />Invite-only</label>
  </fieldset>}
  <button type="submit">Create team</button>
  <p class="muted small">You'll be the team admin — you can invite people and rename the team from team settings.</p>
</form>;

const SharedSection: FC<{ documents: DocumentListRow[] }> = ({ documents }) => <section class="team-group">
  <div class="page-title-row"><div><h2>Shared with you</h2><p class="shared-section-note">Artifacts you can access through a direct invitation or a shared link.</p></div></div>
  <DocumentsTable documents={documents} allowMoves={false} />
</section>;

const NewProjectButton: FC<{ teamId: string }> = ({ teamId }) => <button type="button" class="secondary compact-button" data-new-project data-team-id={teamId}>New project</button>;

const TeamGroup: FC<{ group: TeamDocumentsGroup; view: DocumentsView; single: boolean }> = ({ group, view, single }) => {
  const unfiled = group.documents.filter((doc) => doc.project === null);
  return <section class="team-group">
    <div class="page-title-row">
      <h2 class={single ? 'visually-hidden' : undefined}>{group.teamName}</h2>
      <div class="team-actions"><NewProjectButton teamId={group.teamId} />{group.isTeamAdmin && <a class="muted" href={`/teams/${group.teamId}/settings`}>Team settings</a>}</div>
    </div>
    {view === 'tags' ? (
      group.documents.length === 0 ? <EmptyTeamNote /> : <DocumentsTable documents={group.documents} showProjects />
    ) : group.projects.length === 0 ? (
      group.documents.length === 0 ? <EmptyTeamNote /> : <DocumentsTable documents={group.documents} />
    ) : <>
      <ProjectsTable projects={group.projects} />
      <h3 class="unfiled-heading">Unfiled</h3>
      {unfiled.length > 0 ? <DocumentsTable documents={unfiled} /> : <p class="muted unfiled-empty">No unfiled artifacts.</p>}
    </>}
  </section>;
};

const ViewSwitch: FC<{ view: DocumentsView }> = ({ view }) => <nav class="view-switch" aria-label="Document view">
  <span class="muted">View:</span><a href="/?view=folders" aria-current={view === 'folders' ? 'page' : undefined}>Folders</a><a href="/?view=tags" aria-current={view === 'tags' ? 'page' : undefined}>Tags</a>
</nav>;

export const DocumentsPage: FC<DocumentsPageProps> = ({ user, csrfToken, groups, shared, isInstanceAdmin, view, wizard }) => <Layout mainClass="documents-page" title="Documents - Artifact Colab" user={user} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin}>
  {groups.length === 0 ? <>
    <h1>{wizard ? 'Welcome' : 'Documents'}</h1>
    {wizard ? <TeamWizard csrfToken={csrfToken} wizard={wizard} /> : <div class="empty-state"><p>You're not a member of any team yet.</p><p>{isInstanceAdmin ? <>Create a team and add yourself as a member from the <a href="/admin">admin area</a>.</> : <>Ask a team admin to invite you, then sign in again.</>}</p></div>}
    {shared.length > 0 && <SharedSection documents={shared} />}
  </> : <>
    <div class="documents-heading"><h1>Documents</h1><ViewSwitch view={view} /></div>
    <p id="project-feedback" class="project-feedback" aria-live="polite"></p>
    {groups.map((group) => <TeamGroup group={group} view={view} single={groups.length === 1} />)}
    {shared.length > 0 && <SharedSection documents={shared} />}
    <script id="projects-data" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ csrfToken }).replaceAll('<', '\\u003c') }}></script>
    <script src="/static/projects.js"></script>
  </>}
</Layout>;
