/**
 * The collapsible right-hand sidebar (comments, or changes in compare mode).
 * The collapsed choice is a device preference (like the agent picker on the
 * settings page), so it lives in localStorage, not per document.
 */
const SIDEBAR_COLLAPSED_KEY = 'artifact-colab:comments-collapsed';

/** Wire the collapse/expand buttons; `onToggle` runs after every change so the frame can re-fit. */
export function initSidebarCollapse(onToggle: () => void): void {
  const sidebarAside = document.getElementById('comments-sidebar');
  const collapseButton = document.getElementById('collapse-sidebar');
  const expandButton = document.getElementById('expand-sidebar');

  function setCollapsed(collapsed: boolean, persist: boolean): void {
    if (!sidebarAside || !expandButton) return;
    sidebarAside.classList.toggle('collapsed', collapsed);
    expandButton.hidden = !collapsed;
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
      } catch {
        // Private browsing: the toggle still works, it just isn't remembered.
      }
    }
    // The frame just gained or lost the sidebar's width.
    onToggle();
  }

  collapseButton?.addEventListener('click', () => setCollapsed(true, true));
  expandButton?.addEventListener('click', () => setCollapsed(false, true));
  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') setCollapsed(true, false);
  } catch {
    // Ignore: default to expanded.
  }
}
