/**
 * Fit-to-width scaling for an artifact frame. Claude artifacts are often laid
 * out for a full browser window; the annotator reports the frame's natural
 * content width and, when it exceeds the space available, the whole frame is
 * scaled down to fit (the browser maps pointer coordinates through the
 * transform, so selection and click hit-testing inside the frame keep working).
 */
export class FrameScaler {
  private naturalWidth = 0;
  /** Current scale factor (1 when the content fits). */
  scale = 1;

  constructor(
    private readonly wrap: HTMLElement | null,
    private readonly iframe: HTMLIFrameElement,
  ) {}

  /** Take a content-width report from the annotator. */
  report(contentWidth: number): void {
    // Only ever grow within one document load: once scaled, the frame's
    // inner viewport equals the content width, so later reports shrink.
    if (contentWidth > this.naturalWidth) {
      this.naturalWidth = contentWidth;
      this.apply();
    }
  }

  /** Re-fit after the available width changed (resize, sidebar toggle). */
  apply(): void {
    if (!this.wrap) return;
    const available = this.wrap.clientWidth;
    const availableHeight = this.wrap.clientHeight;
    if (this.naturalWidth <= available + 4) {
      this.scale = 1;
      this.iframe.style.width = '100%';
      this.iframe.style.height = '100%';
      this.iframe.style.transform = '';
      return;
    }
    this.scale = available / this.naturalWidth;
    this.iframe.style.width = `${this.naturalWidth}px`;
    this.iframe.style.height = `${availableHeight / this.scale}px`;
    this.iframe.style.transform = `scale(${this.scale})`;
    this.iframe.style.transformOrigin = '0 0';
  }
}
