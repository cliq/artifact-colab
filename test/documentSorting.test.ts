// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Storage as BrowserStorage } from 'happy-dom';
import { initDocumentSorting } from '../src/client/documentSorting.js';
import { DocumentsTable, type DocumentListRow } from '../src/server/pages/documents.js';

const fixtures: DocumentListRow[] = [
  { id: 'beta', title: 'Beta', visibility: 'team', versionCount: 10, openCommentCount: 2, lastPublishedAt: new Date('2025-12-31'), project: { id: 'z', name: 'Zebra' } },
  { id: 'alpha', title: 'Alpha', visibility: 'public', versionCount: 2, openCommentCount: 10, lastPublishedAt: new Date('2026-01-01'), project: { id: 'a', name: 'apple' } },
  { id: 'gamma', title: 'Gamma', visibility: 'private', versionCount: 1, openCommentCount: 0, lastPublishedAt: null, project: null },
].map((row) => ({ ...row, teamId: 'team', ownerName: 'Owner', ownerEmail: null, canMoveProject: true })) as DocumentListRow[];

const order = (table = 0) => [...document.querySelectorAll('table')[table].querySelectorAll<HTMLTableRowElement>('tbody tr')].map((row) => row.dataset.documentId);
const header = (name: string, table = 0) => [...document.querySelectorAll('table')[table].querySelectorAll<HTMLButtonElement>('thead button')].find((button) => button.textContent?.startsWith(name))!;

beforeEach(async () => {
  vi.stubGlobal('localStorage', new BrowserStorage());
  localStorage.clear();
  document.body.innerHTML = String(await DocumentsTable({ documents: fixtures, showProjects: true }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

test('all six data columns sort by their actual values in both directions', () => {
  initDocumentSorting('sort-user');
  expect(order()).toEqual(['alpha', 'beta', 'gamma']);
  expect(header('Last published').closest('th')?.getAttribute('aria-sort')).toBe('descending');
  for (const [label, ascending, descending] of [
    ['Artifact', ['alpha', 'beta', 'gamma'], ['gamma', 'beta', 'alpha']],
    ['Sharing', ['gamma', 'alpha', 'beta'], ['beta', 'alpha', 'gamma']],
    ['Versions', ['gamma', 'alpha', 'beta'], ['beta', 'alpha', 'gamma']],
    ['Open comments', ['gamma', 'beta', 'alpha'], ['alpha', 'beta', 'gamma']],
    ['Last published', ['beta', 'alpha', 'gamma'], ['alpha', 'beta', 'gamma']],
    ['Project', ['alpha', 'beta', 'gamma'], ['beta', 'alpha', 'gamma']],
  ] as const) {
    header(label).click();
    expect(order(), `${label} ascending`).toEqual(ascending);
    expect(header(label).closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    header(label).click();
    expect(order(), `${label} descending`).toEqual(descending);
    expect(header(label).closest('th')?.getAttribute('aria-sort')).toBe('descending');
  }
});

test('sorting synchronizes team tables, retains row controls, and restores only this account preference', async () => {
  document.body.innerHTML += String(await DocumentsTable({ documents: fixtures, showProjects: true }));
  const move = vi.fn();
  document.querySelector('[data-move-to-project]')!.addEventListener('click', move);
  initDocumentSorting('sort-alice');
  header('Versions', 1).click();
  expect(order(0)).toEqual(['gamma', 'alpha', 'beta']);
  expect(order(1)).toEqual(order(0));
  document.querySelector<HTMLButtonElement>('[data-move-to-project][data-document-id="beta"]')!.click();
  expect(move).toHaveBeenCalledOnce();
  const markup = String(await DocumentsTable({ documents: fixtures, showProjects: true }));
  document.body.innerHTML = markup;
  initDocumentSorting('sort-alice');
  expect(order()).toEqual(['gamma', 'alpha', 'beta']);
  document.body.innerHTML = markup;
  initDocumentSorting('sort-bob');
  expect(order()).toEqual(['alpha', 'beta', 'gamma']);
});

test('unavailable or malformed storage does not prevent sorting', () => {
  localStorage.setItem('sort-user', '{invalid');
  initDocumentSorting('sort-user');
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  header('Versions').click();
  expect(order()).toEqual(['gamma', 'alpha', 'beta']);
});
