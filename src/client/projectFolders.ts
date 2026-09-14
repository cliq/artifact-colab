/** Inline folder disclosure, preserving expansion through moves and reloads. */
export function initProjectFolders(storageKey: string): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-project-toggle]')];
  if (!buttons.length) return;
  let openIds: string[] = [];
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
    if (Array.isArray(saved)) openIds = saved.filter((id): id is string => typeof id === 'string');
  } catch { /* Disclosure works without storage. */ }

  const save = (): void => {
    const expanded = buttons.filter((button) => button.getAttribute('aria-expanded') === 'true').map((button) => button.dataset.projectId);
    try { sessionStorage.setItem(storageKey, JSON.stringify(expanded)); } catch { /* Optional preference. */ }
  };
  const setOpen = (button: HTMLButtonElement, open: boolean): void => {
    const content = document.getElementById(button.getAttribute('aria-controls') ?? '');
    if (!content) return;
    content.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  for (const button of buttons) {
    setOpen(button, openIds.includes(button.dataset.projectId ?? ''));
    const toggle = (): void => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      setOpen(button, open);
      // A collapsed deep-linked Project should stay collapsed on reload.
      if (!open && window.location.hash === `#project-${button.dataset.projectId}`) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      save();
    };
    button.addEventListener('click', toggle);
    button.closest('.project-row')?.addEventListener('click', (event) => {
      if ((event.target as Element).closest('button, a, .project-row-actions')) return;
      button.focus({ preventScroll: true });
      toggle();
    });
  }
  const revealHash = (): void => {
    const button = buttons.find((item) => window.location.hash === `#project-${item.dataset.projectId}`);
    if (!button) return;
    setOpen(button, true);
    save();
    button.closest('.project-row')?.scrollIntoView({ block: 'nearest' });
  };
  window.addEventListener('hashchange', revealHash);
  revealHash();
}
