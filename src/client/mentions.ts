/**
 * The `@` mention picker for comment textareas. Typing `@` (at the start or
 * after whitespace) opens a list of teammates filtered by what follows; picking
 * one replaces the partial token with `@email ` — the form the server resolves
 * (see shared/mentions.ts). One picker instance serves every textarea on the
 * page; it is positioned under whichever one is being typed in.
 */

import { splitMentions } from '../shared/mentions.js';

export interface Mentionable {
  email: string;
  name: string | null;
  avatarUrl: string;
}

export interface MentionDTO {
  email: string;
  name: string | null;
}

const MAX_ITEMS = 8;

/** Marks a textarea whose picker is open, so Enter selects instead of submitting. */
export const MENTION_OPEN_ATTR = 'data-mention-open';

/** The `@token` the caret sits in, if any: where it starts and the text typed after `@`. */
function tokenAtCaret(textarea: HTMLTextAreaElement): { start: number; query: string } | null {
  const caret = textarea.selectionStart;
  if (caret !== textarea.selectionEnd) return null;
  const before = textarea.value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // Only a fresh `@` — one at the start or after whitespace — begins a mention;
  // the `@` inside an already-inserted email doesn't reopen the picker.
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

function matches(user: Mentionable, query: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  return user.email.toLowerCase().includes(q) || (user.name ?? '').toLowerCase().includes(q);
}

export class MentionPicker {
  private readonly root: HTMLDivElement;
  private target: HTMLTextAreaElement | null = null;
  private tokenStart = 0;
  private items: Mentionable[] = [];
  private selected = 0;

  constructor(private readonly members: () => Mentionable[]) {
    this.root = document.createElement('div');
    this.root.className = 'mention-picker';
    this.root.setAttribute('role', 'listbox');
    this.root.hidden = true;
    document.body.appendChild(this.root);
    // The textarea scrolls with the sidebar while the picker is fixed: follow it.
    window.addEventListener('scroll', () => this.reposition(), true);
    window.addEventListener('resize', () => this.reposition());
  }

  /** Wire a textarea: the picker opens as the user types an `@token` and closes when the caret leaves it. */
  attach(textarea: HTMLTextAreaElement): void {
    const refresh = (): void => this.refresh(textarea);
    textarea.addEventListener('input', refresh);
    textarea.addEventListener('click', refresh);
    textarea.addEventListener('keyup', (e) => {
      // Up/Down move the highlight while the list is open; only caret moves re-check the token.
      const navigating = this.target === textarea && !this.root.hidden && (e.key === 'ArrowUp' || e.key === 'ArrowDown');
      if (navigating) return;
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') refresh();
    });
    textarea.addEventListener('blur', () => {
      if (this.target === textarea) this.close();
    });
    textarea.addEventListener('keydown', (e) => {
      if (this.target !== textarea || this.root.hidden) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.select((this.selected + 1) % this.items.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.select((this.selected - 1 + this.items.length) % this.items.length);
          break;
        case 'Enter':
        case 'Tab':
          if (e.isComposing) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          this.insert(this.items[this.selected]!);
          break;
        case 'Escape':
          e.preventDefault();
          e.stopImmediatePropagation();
          this.close();
          break;
      }
    });
  }

  /**
   * Re-evaluate the token under the caret of `textarea` and show, update, or
   * hide the list accordingly. Also called after the sidebar rebuilds a
   * textarea mid-typing, so the picker carries over to the replacement.
   */
  refresh(textarea: HTMLTextAreaElement): void {
    const token = tokenAtCaret(textarea);
    const members = token ? this.members().filter((m) => matches(m, token.query)).slice(0, MAX_ITEMS) : [];
    if (!token || members.length === 0) {
      if (this.target === textarea) this.close();
      return;
    }
    // Keep the highlighted row when the same list is merely re-checked (a
    // caret move, a sidebar rebuild); start over when the candidates change.
    const sameList =
      this.target === textarea &&
      this.items.length === members.length &&
      this.items.every((item, i) => item.email === members[i]!.email);
    this.target = textarea;
    this.tokenStart = token.start;
    this.items = members;
    if (!sameList) this.selected = 0;
    this.render();
    textarea.setAttribute(MENTION_OPEN_ATTR, 'true');
    this.root.hidden = false;
    this.reposition();
  }

  close(): void {
    this.root.hidden = true;
    this.target?.removeAttribute(MENTION_OPEN_ATTR);
    this.target = null;
  }

  private render(): void {
    this.root.textContent = '';
    this.items.forEach((user, index) => {
      const item = document.createElement('div');
      item.className = `mention-option${index === this.selected ? ' selected' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === this.selected ? 'true' : 'false');
      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = user.avatarUrl;
      avatar.alt = '';
      avatar.setAttribute('referrerpolicy', 'no-referrer');
      const name = document.createElement('span');
      name.className = 'mention-name';
      name.textContent = user.name ?? user.email;
      item.append(avatar, name);
      if (user.name) {
        const email = document.createElement('span');
        email.className = 'mention-email';
        email.textContent = user.email;
        item.appendChild(email);
      }
      // Swallowing mousedown keeps the textarea focused, so the blur handler
      // doesn't close the picker before the pick lands; the click itself must
      // not bubble to the sidebar's deselect/focus handlers, which would
      // collapse the card being replied to.
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.insert(user);
      });
      item.addEventListener('mousemove', () => {
        if (this.selected !== index) this.select(index);
      });
      this.root.appendChild(item);
    });
  }

  private select(index: number): void {
    this.selected = index;
    this.root.querySelectorAll<HTMLElement>('.mention-option').forEach((node, i) => {
      node.classList.toggle('selected', i === index);
      node.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });
    this.root.children[index]?.scrollIntoView({ block: 'nearest' });
  }

  private insert(user: Mentionable): void {
    const textarea = this.target;
    if (!textarea) return;
    const end = textarea.selectionStart;
    textarea.setRangeText(`@${user.email} `, this.tokenStart, end, 'end');
    this.close();
    // setRangeText doesn't fire `input`; draft tracking and our own refresh listen for it.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  private reposition(): void {
    const textarea = this.target;
    if (!textarea || this.root.hidden) return;
    if (!textarea.isConnected) {
      this.close();
      return;
    }
    const rect = textarea.getBoundingClientRect();
    const height = this.root.offsetHeight;
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight ? Math.max(4, rect.top - height - 4) : below;
    this.root.style.left = `${rect.left}px`;
    this.root.style.top = `${top}px`;
    this.root.style.width = `${rect.width}px`;
  }
}

/**
 * The comment body as DOM: plain text with each resolved `@email` painted as
 * a chip showing the person's display name (hover reveals the email).
 */
export function renderMentionBody(body: string, mentions: MentionDTO[]): (Node | string)[] {
  const byEmail = new Map(mentions.map((m) => [m.email.toLowerCase(), m]));
  return splitMentions(body, new Set(byEmail.keys())).map((segment) => {
    if (segment.type === 'text') return segment.text;
    const mention = byEmail.get(segment.email.toLowerCase())!;
    const chip = document.createElement('span');
    chip.className = 'mention';
    chip.title = mention.email;
    chip.textContent = `@${mention.name ?? mention.email}`;
    return chip;
  });
}

export const MENTION_CSS = `
.mention { display: inline; padding: 0 3px; border-radius: 3px; font-weight: 600; color: var(--color-accent); background: color-mix(in srgb, var(--color-accent-bright) 12%, var(--color-surface)); white-space: nowrap; }
.mention-picker { position: fixed; z-index: 1000; box-sizing: border-box; max-height: 240px; overflow-y: auto; padding: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12); font-size: 12px; }
.mention-picker[hidden] { display: none; }
.mention-option { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--radius-sm); cursor: pointer; color: var(--color-ink); }
.mention-option.selected { background: var(--color-accent-wash, var(--color-paper-2)); }
.mention-option .avatar { width: 18px; height: 18px; border-radius: 50%; flex: none; }
.mention-option .mention-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mention-option .mention-email { color: var(--color-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
