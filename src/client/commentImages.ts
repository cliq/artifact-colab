/**
 * Images on comments: the attachment tray under a composer (button, paste,
 * drag and drop, removable previews), the thumbnail strip under a posted
 * comment, and the lightbox a thumbnail opens. The lightbox fits the image to
 * the window; clicking an image larger than that shows it at full size, with
 * the overlay scrolling to reveal the rest.
 *
 * The limits mirror the server's (`services/commentImages.ts`), which checks
 * them again and sniffs the bytes; these are here to fail fast.
 */

export const MAX_COMMENT_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface CommentImageDTO {
  id: string;
  mime: string;
  size: number;
  url: string;
}

export const COMMENT_IMAGES_CSS = `
.attach-tray { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.attach-tray:empty { display: none; }
.attach-preview { position: relative; width: 48px; height: 48px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; background: var(--color-paper-2); }
.attach-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.attach-remove { position: absolute; top: 1px; right: 1px; width: 16px; height: 16px; padding: 0; border: none; border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 11px; line-height: 16px; cursor: pointer; }
.attach-remove:hover { background: rgba(0, 0, 0, 0.85); }
button.attach-btn { font: inherit; font-size: 12px; padding: 4px 8px; border: 1px dashed var(--color-rule-2); border-radius: var(--radius-pill); background: transparent; color: var(--color-muted); cursor: pointer; white-space: nowrap; }
button.attach-btn:hover:not(:disabled) { color: var(--color-accent); border-color: var(--color-accent-bright); }
button.attach-btn:disabled { opacity: 0.5; cursor: default; }
button.attach-btn.compact { padding: 4px 7px; }
.attach-drop { outline: 2px dashed var(--color-accent-bright); outline-offset: 2px; }
.comment-images { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
.comment-images button { width: 72px; height: 72px; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; background: var(--color-paper-2); cursor: zoom-in; }
.comment-images button:hover { border-color: var(--color-accent-bright); }
.comment-images img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thread-card.collapsed .comment-images button { width: 36px; height: 36px; }
.thread-card.stub .comment-images { display: none; }
.ac-lightbox { position: fixed; inset: 0; z-index: 1000; background: rgba(12, 10, 9, 0.94); display: flex; flex-direction: column; }
.ac-lightbox-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; color: #f5f2ee; font-size: 12px; font-family: var(--font-mono); flex: none; }
.ac-lightbox-bar .spacer { flex: 1; }
.ac-lightbox-bar a, .ac-lightbox-bar button { font: inherit; font-size: 12px; color: #f5f2ee; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: var(--radius-pill); padding: 4px 10px; cursor: pointer; text-decoration: none; }
.ac-lightbox-bar a:hover, .ac-lightbox-bar button:hover { background: rgba(255, 255, 255, 0.2); }
.ac-lightbox-stage { flex: 1; min-height: 0; overflow: auto; display: flex; position: relative; }
.ac-lightbox-stage img { margin: auto; max-width: calc(100vw - 32px); max-height: calc(100vh - 72px); object-fit: contain; cursor: default; display: block; }
.ac-lightbox-stage.zoomable img { cursor: zoom-in; }
.ac-lightbox-stage.zoomed img { max-width: none; max-height: none; cursor: zoom-out; }
.ac-lightbox-nav { position: fixed; top: 50%; transform: translateY(-50%); width: 40px; height: 56px; border: none; border-radius: var(--radius-md); background: rgba(255, 255, 255, 0.12); color: #fff; font-size: 22px; cursor: pointer; }
.ac-lightbox-nav:hover { background: rgba(255, 255, 255, 0.25); }
.ac-lightbox-nav.prev { left: 12px; }
.ac-lightbox-nav.next { right: 12px; }
`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Pending images for one composer. The tray owns the File list and its
 * previews; `attachTo` wires paste and drop on the composer's textarea.
 * `onError` reports a rejected file (wrong type, too big, over the limit),
 * and is called with '' to clear that message once the selection changes.
 * `compact` shows the button as an icon only, for the narrow reply row.
 */
export class AttachmentTray {
  /** The previews; empty (and hidden) until an image is attached. */
  readonly element = h('div', 'attach-tray');
  /** The "attach" button with its hidden file input. */
  readonly control = h('span');
  private readonly button = h('button', 'attach-btn', '📎 Image');
  private readonly input = h('input');
  private files: File[] = [];
  private urls: string[] = [];

  constructor(
    private readonly onError: (message: string) => void,
    private readonly onChange: (files: File[]) => void = () => undefined,
    compact = false,
  ) {
    if (compact) {
      this.button.textContent = '📎';
      this.button.classList.add('compact');
      this.button.setAttribute('aria-label', 'Attach images');
    }
    this.input.type = 'file';
    this.input.accept = ACCEPTED_TYPES.join(',');
    this.input.multiple = true;
    this.input.hidden = true;
    this.button.type = 'button';
    this.button.title = `Attach up to ${MAX_COMMENT_IMAGES} images — or paste or drop them into the text box`;
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.input.click();
    });
    this.input.addEventListener('click', (e) => e.stopPropagation());
    this.input.addEventListener('change', () => {
      this.add(Array.from(this.input.files ?? []));
      this.input.value = '';
    });
    this.control.append(this.button, this.input);
  }

  get selected(): File[] {
    return [...this.files];
  }

  attachTo(textarea: HTMLTextAreaElement): void {
    textarea.addEventListener('paste', (e) => {
      const images = Array.from(e.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (images.length === 0) return;
      // Rich copies (e.g. from a document) carry text too; keep that behaviour.
      if (!e.clipboardData?.getData('text/plain')) e.preventDefault();
      this.add(images);
    });
    textarea.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      textarea.classList.add('attach-drop');
    });
    textarea.addEventListener('dragleave', () => textarea.classList.remove('attach-drop'));
    textarea.addEventListener('drop', (e) => {
      textarea.classList.remove('attach-drop');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      this.add(files);
    });
  }

  add(incoming: File[]): void {
    this.onError('');
    for (const file of incoming) {
      if (this.files.length >= MAX_COMMENT_IMAGES) {
        this.onError(`A comment can have at most ${MAX_COMMENT_IMAGES} images.`);
        break;
      }
      if (!ACCEPTED_TYPES.includes(file.type)) {
        this.onError(`${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP image.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        this.onError(`${file.name || 'That image'} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);
        continue;
      }
      this.files.push(file);
    }
    this.render();
  }

  set(files: File[]): void {
    this.files = files.slice(0, MAX_COMMENT_IMAGES);
    this.render();
  }

  clear(): void {
    this.files = [];
    this.render();
  }

  private render(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.element.textContent = '';
    this.files.forEach((file, index) => {
      const url = URL.createObjectURL(file);
      this.urls.push(url);
      const preview = h('div', 'attach-preview');
      const img = h('img');
      img.src = url;
      img.alt = file.name;
      img.title = file.name;
      const remove = h('button', 'attach-remove', '×');
      remove.type = 'button';
      remove.title = 'Remove image';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.files.splice(index, 1);
        this.onError('');
        this.render();
      });
      preview.append(img, remove);
      this.element.appendChild(preview);
    });
    this.button.disabled = this.files.length >= MAX_COMMENT_IMAGES;
    this.onChange(this.selected);
  }
}

/**
 * The request body for a new comment or reply: JSON when there are no
 * images, otherwise multipart with the JSON in `payload`.
 */
export function commentRequestBody(payload: unknown, files: File[]): { body: BodyInit; contentType: string | null } {
  if (files.length === 0) return { body: JSON.stringify(payload), contentType: 'application/json' };
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const file of files) form.append('images', file, file.name || 'image');
  // The browser sets the multipart boundary itself.
  return { body: form, contentType: null };
}

/** Thumbnails for a posted comment; each opens the lightbox at its image. */
export function imageStrip(images: CommentImageDTO[]): HTMLElement | null {
  if (images.length === 0) return null;
  const strip = h('div', 'comment-images');
  images.forEach((image, index) => {
    const button = h('button');
    button.type = 'button';
    button.title = 'View image';
    button.setAttribute('aria-label', `View image ${index + 1} of ${images.length}`);
    const img = h('img');
    img.src = image.url;
    img.alt = '';
    img.loading = 'lazy';
    button.appendChild(img);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(images, index);
    });
    strip.appendChild(button);
  });
  return strip;
}

/** Full-window viewer: fit to screen, click to see full size, arrows between a comment's images, Esc or backdrop to close. */
export function openLightbox(images: CommentImageDTO[], startIndex: number): void {
  let index = startIndex;
  const previousFocus = document.activeElement as HTMLElement | null;

  const overlay = h('div', 'ac-lightbox');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Image viewer');

  const counter = h('span');
  const zoomButton = h('button', undefined, 'Actual size');
  zoomButton.type = 'button';
  const original = h('a', undefined, 'Open original');
  original.target = '_blank';
  original.rel = 'noopener';
  const close = h('button', undefined, 'Close ✕');
  close.type = 'button';
  const bar = h('div', 'ac-lightbox-bar');
  bar.append(counter, h('span', 'spacer'), zoomButton, original, close);

  const stage = h('div', 'ac-lightbox-stage');
  const img = h('img');
  img.alt = '';
  stage.appendChild(img);
  overlay.append(bar, stage);

  const nav = (dir: 1 | -1, label: string, className: string): HTMLButtonElement => {
    const button = h('button', `ac-lightbox-nav ${className}`, dir === 1 ? '›' : '‹');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      show(index + dir);
    });
    return button;
  };
  if (images.length > 1) overlay.append(nav(-1, 'Previous image', 'prev'), nav(1, 'Next image', 'next'));

  /** Zooming only means something when the image is shrunk to fit. */
  function updateZoomable(): void {
    const zoomed = stage.classList.contains('zoomed');
    const shrunk = img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1;
    stage.classList.toggle('zoomable', !zoomed && shrunk);
    zoomButton.hidden = !zoomed && !shrunk;
    zoomButton.textContent = zoomed ? 'Fit to screen' : 'Actual size';
  }

  function setZoomed(zoomed: boolean, at?: { x: number; y: number }): void {
    const fitted = { width: img.clientWidth, height: img.clientHeight, rect: img.getBoundingClientRect() };
    stage.classList.toggle('zoomed', zoomed);
    if (zoomed && at) {
      // Keep the clicked point under the cursor after scaling up.
      const fx = (at.x - fitted.rect.left) / fitted.width;
      const fy = (at.y - fitted.rect.top) / fitted.height;
      stage.scrollLeft = fx * img.naturalWidth - (at.x - stage.getBoundingClientRect().left);
      stage.scrollTop = fy * img.naturalHeight - (at.y - stage.getBoundingClientRect().top);
    }
    updateZoomable();
  }

  function show(next: number): void {
    index = (next + images.length) % images.length;
    const image = images[index]!;
    stage.classList.remove('zoomed', 'zoomable');
    img.src = image.url;
    original.href = image.url;
    counter.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : '';
    if (img.complete) updateZoomable();
  }

  function dismiss(): void {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', updateZoomable);
    overlay.remove();
    previousFocus?.focus?.();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') dismiss();
    else if (e.key === 'ArrowLeft' && images.length > 1) show(index - 1);
    else if (e.key === 'ArrowRight' && images.length > 1) show(index + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  img.addEventListener('load', updateZoomable);
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    if (stage.classList.contains('zoomed')) setZoomed(false);
    else if (stage.classList.contains('zoomable')) setZoomed(true, { x: e.clientX, y: e.clientY });
  });
  zoomButton.addEventListener('click', (e) => {
    e.stopPropagation();
    setZoomed(!stage.classList.contains('zoomed'));
  });
  close.addEventListener('click', dismiss);
  stage.addEventListener('click', (e) => {
    if (e.target === stage) dismiss();
  });
  overlay.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', updateZoomable);

  document.body.appendChild(overlay);
  show(index);
  close.focus();
}
