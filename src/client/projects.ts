/** Project creation/management plus document-list move controls. */

import { initMovePickers, showStoredProjectFeedback, storeProjectFeedback } from './projectPicker.js';
import { initDocumentSorting } from './documentSorting.js';
import { initProjectFolders } from './projectFolders.js';
import { initProjectMenus } from './projectMenus.js';

interface ProjectsData {
  csrfToken: string;
  userId?: string;
  project?: { id: string; name: string };
  view?: 'folders' | 'tags';
}

interface ProjectMutation {
  project?: { id: string; name: string };
  error?: string;
}

function responseError(payload: unknown, fallback: string): string {
  return payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
    ? payload.error
    : fallback;
}

function setFeedback(message: string, kind?: 'error' | 'success'): void {
  const feedback = document.getElementById('project-feedback');
  if (!feedback) return;
  if (kind) feedback.dataset['kind'] = kind;
  else feedback.removeAttribute('data-kind');
  feedback.textContent = message;
}

function askForName(title: string, action: string, initial = ''): Promise<string | null> {
  const dialog = document.createElement('dialog');
  dialog.className = 'project-dialog';
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'project-dialog-form';
  const heading = document.createElement('h2');
  heading.id = 'project-dialog-heading';
  dialog.setAttribute('aria-labelledby', heading.id);
  heading.textContent = title;
  const label = document.createElement('label');
  label.htmlFor = 'project-name-input';
  label.textContent = 'Project name';
  const input = document.createElement('input');
  input.id = 'project-name-input';
  input.type = 'text';
  input.required = true;
  input.autocomplete = 'off';
  input.value = initial;
  const actions = document.createElement('div');
  actions.className = 'project-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = action;
  actions.append(cancel, submit);
  form.append(heading, label, input, actions);
  dialog.appendChild(form);
  document.body.appendChild(dialog);

  return new Promise((resolve) => {
    const finish = (value: string | null): void => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!input.reportValidity()) return;
      finish(input.value);
    });
    dialog.showModal();
    input.focus();
    input.select();
  });
}

function initCreate(data: ProjectsData): void {
  document.querySelectorAll<HTMLButtonElement>('[data-new-project]').forEach((button) => {
    button.addEventListener('click', () => void askForName('New project', 'Create project').then((name) => {
      if (name === null) return;
      button.disabled = true;
      setFeedback('Creating project…');
      return fetch(`/api/teams/${encodeURIComponent(button.dataset['teamId'] ?? '')}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrfToken },
        body: JSON.stringify({ name }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => null) as ProjectMutation | null;
        if (!response.ok || !payload?.project) throw new Error(responseError(payload, 'Could not create this project.'));
        storeProjectFeedback('Project created.');
        window.location.assign(`/?view=folders#project-${encodeURIComponent(payload.project.id)}`);
      }).catch((error: unknown) => {
        button.disabled = false;
        setFeedback(error instanceof Error ? error.message : 'Could not create this project.', 'error');
      });
    }));
  });
}

function initManage(data: ProjectsData): void {
  document.querySelectorAll<HTMLButtonElement>('[data-rename-project]').forEach((rename) => {
    const project = { id: rename.dataset.projectId ?? data.project?.id ?? '', name: rename.dataset.projectName ?? data.project?.name ?? '' };
    rename.addEventListener('click', () => void askForName('Rename project', 'Rename project', project.name).then((name) => {
      if (name === null) return;
      rename.disabled = true;
      setFeedback('Renaming project…');
      return fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrfToken },
        body: JSON.stringify({ name }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => null) as ProjectMutation | null;
        if (!response.ok || !payload?.project) throw new Error(responseError(payload, 'Could not rename this project.'));
        storeProjectFeedback('Project renamed.');
        window.location.reload();
      }).catch((error: unknown) => {
        rename.disabled = false;
        setFeedback(error instanceof Error ? error.message : 'Could not rename this project.', 'error');
      });
    }));
  });

  document.querySelectorAll<HTMLButtonElement>('[data-delete-project]').forEach((remove) => {
    const projectId = remove.dataset.projectId ?? data.project?.id ?? '';
    remove.addEventListener('click', () => {
      const confirmed = window.confirm('Delete this project? Its artifacts will become Unfiled for the team. Artifacts and their sharing settings will be kept.');
      if (!confirmed) return;
      remove.disabled = true;
      setFeedback('Deleting project…');
      void fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
        headers: { 'x-csrf-token': data.csrfToken },
      }).then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(responseError(payload, 'Could not delete this project.'));
        storeProjectFeedback('Project deleted. Its artifacts are now Unfiled.');
        if (data.project) window.location.assign(`/?view=${data.view ?? 'folders'}`);
        else window.location.reload();
      }).catch((error: unknown) => {
        remove.disabled = false;
        setFeedback(error instanceof Error ? error.message : 'Could not delete this project.', 'error');
      });
    });
  });
}

function boot(): void {
  const bootstrap = document.getElementById('projects-data');
  if (!bootstrap?.textContent) return;
  const data = JSON.parse(bootstrap.textContent) as ProjectsData;
  showStoredProjectFeedback();
  initProjectFolders(`artifact-colab-open-projects-${data.userId ?? ''}`);
  initProjectMenus();
  initDocumentSorting(`artifact-colab-document-sort-${data.userId ?? ''}`);
  initCreate(data);
  initManage(data);
  initMovePickers({ csrfToken: data.csrfToken, honorReturnUrl: window.location.pathname.startsWith('/p/') });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
