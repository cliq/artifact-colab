/** Popovers escape table clipping, including on the final collapsed row. */
export function initProjectMenus(): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.project-settings-button[popovertarget]')];
  const position = (button: HTMLButtonElement, menu: HTMLElement): void => {
    const trigger = button.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const left = Math.max(8, Math.min(trigger.right - bounds.width, viewportWidth - bounds.width - 8));
    const below = trigger.bottom + 6;
    const top = below + bounds.height <= viewportHeight - 8 ? below : Math.max(8, trigger.top - bounds.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  for (const button of buttons) {
    const menu = document.getElementById(button.getAttribute('popovertarget')!);
    if (!menu) continue;
    menu.addEventListener('toggle', () => {
      const open = menu.matches(':popover-open');
      button.setAttribute('aria-expanded', String(open));
      if (open) position(button, menu);
    });
    menu.addEventListener('click', (event) => {
      if ((event.target as Element).closest('button') && menu.matches(':popover-open')) menu.hidePopover();
    });
  }
  const reposition = (): void => {
    for (const button of buttons) {
      const menu = document.getElementById(button.getAttribute('popovertarget')!);
      if (menu?.matches(':popover-open')) position(button, menu);
    }
  };
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
}
