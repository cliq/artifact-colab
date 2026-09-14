/** Shared, dependency-free Move to project picker used by lists and the viewer. */

interface ProjectOption {
  id: string;
  name: string;
}

interface ProjectListResponse {
  projects?: ProjectOption[];
  error?: string;
}

interface MutationResponse {
  project?: ProjectOption | null;
  returnUrl?: string;
  error?: string;
}

export interface MovePickerOptions {
  csrfToken: string;
  /** The Project page should honor a returnUrl if its last readable artifact moves away. */
  honorReturnUrl?: boolean;
}

function responseError(payload: unknown, fallback: string): string {
  return payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
    ? payload.error
    : fallback;
}

function projectDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.className = 'project-dialog';
  dialog.setAttribute('aria-labelledby', 'move-project-heading');
  dialog.innerHTML = `
    <form method="dialog" class="project-dialog-form">
      <h2 id="move-project-heading">Move to project</h2>
      <label for="move-project-select">Project</label>
      <select id="move-project-select" name="project"></select>
      <button type="button" class="link-button project-new-choice">New project</button>
      <div class="project-new-fields" hidden>
        <label for="move-project-name">Project name</label>
        <input id="move-project-name" type="text" autocomplete="off" />
        <button type="button" class="link-button project-existing-choice">Choose an existing project</button>
      </div>
      <p class="project-dialog-feedback" aria-live="polite"></p>
      <div class="project-dialog-actions">
        <button type="button" class="secondary project-dialog-cancel">Cancel</button>
        <button type="submit" class="project-dialog-submit">Move</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  return dialog;
}

/** Wires every `[data-move-to-project]` button currently in the document. */
export function initMovePickers(options: MovePickerOptions): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-move-to-project]')];
  if (buttons.length === 0) return;
  const dialog = projectDialog();
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const select = dialog.querySelector<HTMLSelectElement>('select')!;
  const feedback = dialog.querySelector<HTMLElement>('.project-dialog-feedback')!;
  const submit = dialog.querySelector<HTMLButtonElement>('.project-dialog-submit')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('.project-dialog-cancel')!;
  const newChoice = dialog.querySelector<HTMLButtonElement>('.project-new-choice')!;
  const existingChoice = dialog.querySelector<HTMLButtonElement>('.project-existing-choice')!;
  const newFields = dialog.querySelector<HTMLElement>('.project-new-fields')!;
  const nameInput = dialog.querySelector<HTMLInputElement>('#move-project-name')!;
  let active: HTMLButtonElement | null = null;
  let creating = false;
  let mutating = false;
  let loadGeneration = 0;
  let loadController: AbortController | null = null;

  const showCreating = (next: boolean): void => {
    creating = next;
    select.hidden = next;
    select.previousElementSibling?.toggleAttribute('hidden', next);
    newChoice.hidden = next;
    newFields.hidden = !next;
    submit.textContent = next ? 'Create and move' : 'Move';
    if (next) nameInput.focus(); else select.focus();
  };

  const closePicker = (): void => {
    if (mutating) return;
    loadGeneration += 1;
    loadController?.abort();
    loadController = null;
    active = null;
    dialog.close();
  };
  cancel.addEventListener('click', closePicker);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closePicker();
  });
  newChoice.addEventListener('click', () => showCreating(true));
  existingChoice.addEventListener('click', () => showCreating(false));

  for (const button of buttons) button.addEventListener('click', () => {
    loadController?.abort();
    const generation = ++loadGeneration;
    const controller = new AbortController();
    loadController = controller;
    active = button;
    creating = false;
    select.hidden = false;
    select.previousElementSibling?.removeAttribute('hidden');
    newChoice.hidden = false;
    newFields.hidden = true;
    submit.textContent = 'Move';
    feedback.textContent = 'Loading projects…';
    feedback.removeAttribute('data-kind');
    submit.disabled = true;
    newChoice.disabled = true;
    nameInput.value = '';
    select.textContent = '';
    dialog.showModal();
    void fetch(`/api/teams/${encodeURIComponent(button.dataset['teamId'] ?? '')}/projects`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as ProjectListResponse | null;
        if (!response.ok || !payload) throw new Error(responseError(payload, 'Could not load projects.'));
        if (generation !== loadGeneration || active !== button || !dialog.open) return;
        const unfiled = document.createElement('option');
        unfiled.value = '';
        unfiled.textContent = 'Unfiled';
        select.appendChild(unfiled);
        for (const project of payload.projects ?? []) {
          const option = document.createElement('option');
          option.value = project.name;
          option.textContent = project.name;
          select.appendChild(option);
        }
        const currentName = button.dataset['projectName'] ?? '';
        const currentStillExists = currentName === '' || [...select.options].some((option) => option.value === currentName);
        if (currentStillExists) {
          select.value = currentName;
          feedback.textContent = '';
        } else {
          const placeholder = document.createElement('option');
          placeholder.textContent = 'Choose a destination';
          placeholder.disabled = true;
          placeholder.selected = true;
          placeholder.dataset['placeholder'] = 'true';
          select.prepend(placeholder);
          feedback.dataset['kind'] = 'error';
          feedback.textContent = 'The current project changed. Choose a destination.';
        }
        submit.disabled = false;
        newChoice.disabled = false;
        select.focus();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== loadGeneration || active !== button || !dialog.open) return;
        feedback.dataset['kind'] = 'error';
        feedback.textContent = error instanceof Error ? error.message : 'Could not load projects.';
        newChoice.disabled = false;
      });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!active) return;
    if (!creating && select.selectedOptions[0]?.dataset['placeholder'] === 'true') {
      feedback.dataset['kind'] = 'error';
      feedback.textContent = 'Choose a destination.';
      select.focus();
      return;
    }
    const teamId = active.dataset['teamId'] ?? '';
    const documentId = active.dataset['documentId'] ?? '';
    const name = nameInput.value;
    mutating = true;
    loadGeneration += 1;
    loadController?.abort();
    loadController = null;
    submit.disabled = true;
    cancel.disabled = true;
    newChoice.disabled = true;
    existingChoice.disabled = true;
    select.disabled = true;
    nameInput.disabled = true;
    feedback.removeAttribute('data-kind');
    feedback.textContent = creating ? 'Creating project…' : 'Moving artifact…';
    const request = creating
      ? fetch(`/api/teams/${encodeURIComponent(teamId)}/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': options.csrfToken },
          body: JSON.stringify({ name, document_id: documentId }),
        })
      : fetch(`/api/docs/${encodeURIComponent(documentId)}/project`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-csrf-token': options.csrfToken },
          body: JSON.stringify({ project: select.value || null }),
        });
    void request.then(async (response) => {
      const payload = await response.json().catch(() => null) as MutationResponse | null;
      if (!response.ok || !payload) throw new Error(responseError(payload, creating ? 'Could not create this project.' : 'Could not move this artifact.'));
      storeProjectFeedback(creating ? 'Project created and artifact moved.' : 'Artifact moved.');
      if (options.honorReturnUrl && payload.returnUrl) window.location.assign(payload.returnUrl);
      else window.location.reload();
    }).catch((error: unknown) => {
      mutating = false;
      submit.disabled = false;
      cancel.disabled = false;
      newChoice.disabled = false;
      existingChoice.disabled = false;
      select.disabled = false;
      nameInput.disabled = false;
      feedback.dataset['kind'] = 'error';
      feedback.textContent = error instanceof Error ? error.message : 'Could not move this artifact.';
    });
  });
}

export function showStoredProjectFeedback(): void {
  let message: string | null = null;
  try {
    message = sessionStorage.getItem('artifact-colab-project-feedback');
  } catch {
    return;
  }
  const target = document.getElementById('project-feedback');
  if (!message || !target) return;
  try { sessionStorage.removeItem('artifact-colab-project-feedback'); } catch { /* Optional feedback only. */ }
  target.dataset['kind'] = 'success';
  target.textContent = message;
}

export function storeProjectFeedback(message: string): void {
  try { sessionStorage.setItem('artifact-colab-project-feedback', message); } catch { /* Navigation still proceeds. */ }
}
