/**
 * Mobile presentation of the viewer (<= 700 CSS px): a compact top bar, a
 * Reading view / Full layout toggle, and the comments (or changes) panel as a
 * modal bottom sheet. It never touches the artifact iframe's document or src,
 * and owns no comment data: the viewer registers what "Comment on selection"
 * does. Browser-only; covered by Playwright.
 */

export const MOBILE_QUERY = '(max-width: 700px)';

export interface MobileViewer {
  isMobile(): boolean;
  openPanel(): void;
  closePanel(): void;
  /** Swap the bar's Comments action for Comment on selection while a valid selection exists. */
  setSelectionAvailable(available: boolean): void;
  /**
   * `snapshot` runs on the first press (before focus can move and clear the
   * selection); `commit` runs on activation and may focus the composer.
   */
  onCommentOnSelection(snapshot: () => void, commit: () => void): void;
}

export function initMobileViewer(onLayoutChange: () => void): MobileViewer {
  const viewer = document.querySelector<HTMLElement>('.viewer');
  const sheet = document.getElementById('comments-sidebar');
  const backdrop = document.getElementById('sheet-backdrop');
  const commentsButton = document.getElementById('mobile-comments') as HTMLButtonElement | null;
  const selectionButton = document.getElementById('mobile-selection') as HTMLButtonElement | null;
  const layoutButton = document.getElementById('mobile-layout') as HTMLButtonElement | null;
  const closeButton = document.getElementById('close-sheet') as HTMLButtonElement | null;
  const mq = window.matchMedia(MOBILE_QUERY);

  let open = false;
  let opener: HTMLElement | null = null;
  let selectionAvailable = false;
  let pressing = false;
  let hideAfterPress = false;
  let snapshot: () => void = () => {};
  let commit: () => void = () => {};

  const isMobile = (): boolean => mq.matches;

  /** Elements made inert while the sheet is open: everything but the sheet. */
  const background = (): HTMLElement[] =>
    [document.querySelector<HTMLElement>('header.site-header'), document.querySelector<HTMLElement>('.viewer-main')].filter(
      (node): node is HTMLElement => node !== null,
    );

  function syncDialog(): void {
    if (!sheet || !viewer) return;
    const modal = open && isMobile();
    viewer.dataset['sheet'] = modal ? 'open' : 'closed';
    if (modal) {
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', document.getElementById('comments-title')?.textContent ?? 'Comments');
    } else {
      sheet.removeAttribute('role');
      sheet.removeAttribute('aria-modal');
      sheet.removeAttribute('aria-label');
    }
    for (const node of background()) node.toggleAttribute('inert', modal);
    fitToVisualViewport();
  }

  /** Keep the sheet above the on-screen keyboard where the browser overlays it instead of resizing. */
  function fitToVisualViewport(): void {
    if (!sheet) return;
    const vv = window.visualViewport;
    if (!open || !isMobile() || !vv) {
      sheet.style.removeProperty('bottom');
      sheet.style.removeProperty('max-height');
      return;
    }
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sheet.style.bottom = `${inset}px`;
    sheet.style.maxHeight = `${Math.floor(vv.height * 0.9)}px`;
  }
  window.visualViewport?.addEventListener('resize', fitToVisualViewport);
  window.visualViewport?.addEventListener('scroll', fitToVisualViewport);

  function visibleAction(): HTMLElement | null {
    return [selectionButton, commentsButton].find((b): b is HTMLButtonElement => !!b && !b.hidden) ?? null;
  }

  function openPanel(): void {
    if (!isMobile() || open) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : visibleAction();
    open = true;
    syncDialog();
    closeButton?.focus();
  }

  function closePanel(): void {
    if (!open) return;
    open = false;
    syncDialog();
    const target = opener?.isConnected && !opener.hidden ? opener : visibleAction();
    opener = null;
    target?.focus();
  }

  function render(): void {
    if (commentsButton) commentsButton.hidden = selectionAvailable;
    if (selectionButton) selectionButton.hidden = !selectionAvailable;
  }

  commentsButton?.addEventListener('click', openPanel);
  closeButton?.addEventListener('click', closePanel);
  backdrop?.addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape' && !e.defaultPrevented) return closePanel();
    // Wrap Tab inside the sheet (inert background alone lets focus escape to browser chrome).
    // Focus in another dialog, such as the image lightbox, is left alone.
    if (e.key !== 'Tab' || !sheet || !sheet.contains(e.target as Node)) return;
    const focusable = Array.from(
      sheet.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((node) => !node.hasAttribute('disabled') && node.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  layoutButton?.addEventListener('click', () => {
    if (!viewer) return;
    const full = viewer.dataset['layout'] !== 'full';
    viewer.dataset['layout'] = full ? 'full' : 'reading';
    layoutButton.textContent = full ? 'Reading view' : 'Full layout';
    onLayoutChange();
  });

  // A press can clear the frame's selection (and so hide this very button)
  // before the click lands; hold the button in place until the press ends.
  selectionButton?.addEventListener('pointerdown', () => {
    pressing = true;
    snapshot();
  });
  const endPress = (): void => {
    window.setTimeout(() => {
      pressing = false;
      if (hideAfterPress) {
        hideAfterPress = false;
        selectionAvailable = false;
        render();
      }
    }, 0);
  };
  selectionButton?.addEventListener('pointerup', endPress);
  selectionButton?.addEventListener('pointercancel', endPress);
  selectionButton?.addEventListener('click', () => {
    commit();
    endPress();
  });

  mq.addEventListener('change', () => {
    if (!isMobile() && open) {
      open = false;
      opener = null;
    }
    syncDialog();
    onLayoutChange();
  });

  return {
    isMobile,
    openPanel,
    closePanel,
    setSelectionAvailable(available) {
      if (!available && pressing) {
        hideAfterPress = true;
        return;
      }
      hideAfterPress = false;
      selectionAvailable = available;
      render();
    },
    onCommentOnSelection(onSnapshot, onCommit) {
      snapshot = onSnapshot;
      commit = onCommit;
    },
  };
}
