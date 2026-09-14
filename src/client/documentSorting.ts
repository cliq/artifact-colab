/** Sort the visible artifact tables together; no hidden server data is fetched. */
const columns = ['title', 'sharing', 'versions', 'comments', 'published', 'project'] as const;
type Column = typeof columns[number];
type Direction = 'ascending' | 'descending';
interface Sort { column: Column; direction: Direction }
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isSort(value: unknown): value is Sort {
  if (!value || typeof value !== 'object') return false;
  const sort = value as Sort;
  return columns.includes(sort.column) && (sort.direction === 'ascending' || sort.direction === 'descending');
}

export function initDocumentSorting(storageKey: string): void {
  const tables = [...document.querySelectorAll<HTMLTableElement>('table[data-sortable]')];
  if (!tables.length) return;
  let sort: Sort = { column: 'published', direction: 'descending' };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (isSort(saved)) sort = saved;
  } catch { /* Sorting works when browser storage is unavailable. */ }

  const apply = (): void => {
    for (const table of tables) {
      const buttons = [...table.querySelectorAll<HTMLButtonElement>('thead [data-sort-column]')];
      // Shared-with-you tables have no Project column or metadata.
      const current = buttons.some((button) => button.dataset.sortColumn === sort.column)
        ? sort : { column: 'published' as const, direction: 'descending' as const };
      const numeric = ['versions', 'comments', 'published'].includes(current.column);
      const direction = current.direction === 'ascending' ? 1 : -1;
      const tbody = table.tBodies[0];
      const rows = [...tbody.rows];
      rows.sort((a, b) => {
        const left = a.getAttribute(`data-sort-${current.column}`) ?? '';
        const right = b.getAttribute(`data-sort-${current.column}`) ?? '';
        // Missing dates and Unfiled stay last in either direction.
        if (left === '' && right !== '') return 1;
        if (right === '' && left !== '') return -1;
        const order = numeric ? Number(left) - Number(right) : collator.compare(left, right);
        return order * direction || collator.compare(a.dataset.sortTitle ?? '', b.dataset.sortTitle ?? '')
          || collator.compare(a.dataset.documentId ?? '', b.dataset.documentId ?? '');
      });
      tbody.append(...rows);
      for (const button of buttons) {
        const active = button.dataset.sortColumn === current.column;
        button.closest('th')!.setAttribute('aria-sort', active ? current.direction : 'none');
        const indicator = button.querySelector('.sort-indicator');
        if (indicator) indicator.textContent = active ? current.direction === 'ascending' ? '↑' : '↓' : '↕';
      }
    }
  };
  for (const table of tables) {
    for (const button of table.querySelectorAll<HTMLButtonElement>('thead [data-sort-column]')) {
      button.addEventListener('click', () => {
        const column = button.dataset.sortColumn as Column;
        if (!columns.includes(column)) return;
        const descending = button.closest('th')!.getAttribute('aria-sort') === 'ascending';
        sort = { column, direction: descending ? 'descending' : 'ascending' };
        apply();
        try { localStorage.setItem(storageKey, JSON.stringify(sort)); } catch { /* Optional preference. */ }
      });
    }
  }
  apply();
}
