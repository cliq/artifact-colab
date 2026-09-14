/** Authorized contents and management page for one team Project. */

import type { FC } from 'hono/jsx';

import type { User } from '../db/schema.js';
import type { DocumentListRow, DocumentsView, ProjectSummary } from '../services/documentLists.js';
import { DocumentsTable } from './documents.js';
import { Layout } from './layout.js';

export interface ProjectPageProps {
  user: User;
  csrfToken: string;
  isInstanceAdmin: boolean;
  project: ProjectSummary;
  teamName: string;
  documents: DocumentListRow[];
  view: DocumentsView;
}

export const ProjectPage: FC<ProjectPageProps> = ({ user, csrfToken, isInstanceAdmin, project, teamName, documents, view }) => {
  const bootstrap = JSON.stringify({ csrfToken, project: { id: project.id, name: project.name }, view }).replaceAll('<', '\\u003c');
  return <Layout mainClass="documents-page project-page" title={`${project.name} - Artifact Colab`} user={user} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin}>
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href={`/?view=${view}`}>Documents</a><span aria-hidden="true">/</span><span>{teamName}</span>
    </nav>
    <div class="project-heading">
      <h1 id="project-name">{project.name}</h1>
      <details class="settings-menu project-menu">
        <summary>Project</summary>
        <div class="settings-menu-items">
          <button type="button" class="link-button" data-rename-project>Rename project</button>
          <button type="button" class="link-button danger-link" data-delete-project>Delete project</button>
        </div>
      </details>
    </div>
    <p id="project-feedback" class="project-feedback" aria-live="polite"></p>
    {documents.length > 0 ? <DocumentsTable documents={documents} /> : <div class="empty-state project-empty-state">
      <p>This project is empty.</p>
      <p>Publish an artifact with the project name <strong>{project.name}</strong>, or use <strong>Move to project</strong> on an existing artifact.</p>
      <p><a href={`/?view=${view}`}>Browse artifacts</a></p>
    </div>}
    <script id="projects-data" type="application/json" dangerouslySetInnerHTML={{ __html: bootstrap }}></script>
    <script src="/static/projects.js"></script>
  </Layout>;
};
