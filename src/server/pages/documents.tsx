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
  sortable?: boolean;
  /** Shared-with-you rows remain free of team Project controls. */
  allowMoves?: boolean;
}

/** Reused by the root list and an individual Project page. */
export const DocumentsTable: FC<DocumentsTableProps> = ({ documents, showProjects = false, sortable = showProjects, allowMoves = true }) => (
  <div class="documents-table-scroll">
    <table class={`documents-table${showProjects ? ' documents-table-tags' : ''}`} data-sortable={sortable || undefined}>
      <thead><tr>
        <ColumnHeader label="Artifact" column="title" sortable={sortable} />
        <ColumnHeader label="Sharing" column="sharing" sortable={sortable} />
        <ColumnHeader label="Versions" column="versions" sortable={sortable} />
        <ColumnHeader label="Open comments" column="comments" sortable={sortable} />
        <ColumnHeader label="Last published" column="published" sortable={sortable} />
        {showProjects && <ColumnHeader label="Project" column="project" sortable={sortable} />}
        {allowMoves && <th><span class="visually-hidden">Actions</span></th>}
      </tr></thead>
      <tbody>{documents.map((doc) => <tr data-document-id={doc.id}
        data-sort-title={doc.title} data-sort-sharing={shareLabels[doc.visibility].label}
        data-sort-versions={doc.versionCount} data-sort-comments={doc.openCommentCount}
        data-sort-published={doc.lastPublishedAt?.getTime() ?? ''} data-sort-project={doc.project?.name ?? ''}>
        <td>
          <a class="document-title" href={`/d/${doc.id}`}>{doc.title}</a>
          <div class="document-owner muted" title={doc.ownerEmail ?? undefined}>{doc.ownerName}</div>
        </td>
        <td><ShareBadge visibility={doc.visibility} effectiveRole={doc.effectiveRole} /></td>
        <td>{doc.versionCount}</td><td>{doc.openCommentCount}</td>
        <td class="muted">{doc.lastPublishedAt ? <LocalTime date={doc.lastPublishedAt} split /> : '—'}</td>
        {showProjects && <td>{doc.project ? <a class="project-tag" href={`/?view=folders#project-${doc.project.id}`}>{doc.project.name}</a> : <span class="muted" aria-label="Unfiled">—</span>}</td>}
        {allowMoves && <td class="document-project-action">{doc.canMoveProject && <button
          type="button" class="secondary compact-button" data-move-to-project data-document-id={doc.id}
          data-team-id={doc.teamId} data-project-name={doc.project?.name ?? ''}
        >Move</button>}</td>}
      </tr>)}</tbody>
    </table>
  </div>
);

const ColumnHeader: FC<{ label: string; column: string; sortable: boolean }> = ({ label, column, sortable }) => <th scope="col" aria-sort={sortable ? 'none' : undefined}>
  {sortable ? <button type="button" class="table-sort" data-sort-column={column}>{label}<span class="sort-indicator" aria-hidden="true">↕</span></button> : label}
</th>;

const ProjectsTable: FC<{ projects: ProjectSummary[]; documents: DocumentListRow[] }> = ({ projects, documents }) => <div class="documents-table-scroll project-table-wrap">
  <table class="documents-table projects-table">
    <thead><tr><th>Project</th><th>Artifacts</th><th>Open comments</th><th>Last published</th><th><span class="visually-hidden">Project settings</span></th></tr></thead>
    <tbody>{projects.map((project) => <>
    <tr class="project-row" id={`project-${project.id}`}>
      <td><button type="button" class="project-toggle" data-project-toggle data-project-id={project.id}
        aria-expanded="false" aria-controls={`project-contents-${project.id}`}>
        <span class="project-chevron" aria-hidden="true"></span><span>{project.name}</span>
      </button></td>
      <td>{project.artifactCount}</td><td>{project.openCommentCount}</td>
      <td class="muted">{project.lastPublishedAt ? <LocalTime date={project.lastPublishedAt} split /> : '—'}</td>
      <td class="project-row-actions project-menu">
        <button type="button" class="secondary compact-button project-settings-button" popovertarget={`project-menu-${project.id}`}
          aria-label={`Project settings: ${project.name}`} title="Project settings" aria-expanded="false">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8.5 5.938 9.606 5.422 9.702 2.782 14.298 2.782 14.394 5.422 15.5 5.938 16.5 6.638 18.834 5.401 21.132 9.381 18.894 10.784 19 12 18.894 13.216 21.132 14.619 18.834 18.599 16.5 17.362 15.5 18.062 14.394 18.578 14.298 21.218 9.702 21.218 9.606 18.578 8.5 18.062 7.5 17.362 5.166 18.599 2.868 14.619 5.106 13.216 5 12 5.106 10.784 2.868 9.381 5.166 5.401 7.5 6.638Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <div id={`project-menu-${project.id}`} class="settings-menu-items project-actions-menu" popover="auto">
          <button type="button" class="link-button" data-rename-project data-project-id={project.id} data-project-name={project.name}>Rename project</button>
          <button type="button" class="link-button danger-link" data-delete-project data-project-id={project.id}>Delete project</button>
        </div>
      </td>
    </tr>
    <tr class="project-contents" id={`project-contents-${project.id}`} hidden><td colspan={5}>
      {project.artifactCount > 0 ? <DocumentsTable documents={documents.filter((doc) => doc.project?.id === project.id)} /> : <div class="empty-state project-empty-state">
        <p>This project is empty.</p><p>Publish an artifact with this project name, or move an existing artifact here.</p>
      </div>}
    </td></tr>
    </>)}</tbody>
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

const SharedSection: FC<{ documents: DocumentListRow[]; view: DocumentsView }> = ({ documents, view }) => <section class="team-group">
  <div class="page-title-row"><div><h2>Shared with you</h2><p class="shared-section-note">Artifacts you can access through a direct invitation or a shared link.</p></div></div>
  <DocumentsTable documents={documents} allowMoves={false} sortable={view === 'tags'} />
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
      <ProjectsTable projects={group.projects} documents={group.documents} />
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
    {shared.length > 0 && <SharedSection documents={shared} view={view} />}
  </> : <>
    <div class="documents-heading"><h1>Documents</h1><ViewSwitch view={view} /></div>
    <p id="project-feedback" class="project-feedback" aria-live="polite"></p>
    {groups.map((group) => <TeamGroup group={group} view={view} single={groups.length === 1} />)}
    {shared.length > 0 && <SharedSection documents={shared} view={view} />}
  </>}
  <script id="projects-data" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ csrfToken, userId: user.id, view }).replaceAll('<', '\\u003c') }}></script>
  <script src="/static/projects.js"></script>
</Layout>;
