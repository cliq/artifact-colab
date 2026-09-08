/** Keep outbound navigation out of the artifact iframe, including dynamic links. */
export function installExternalLinks(doc: Document): void {
  const prepareLink = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a[href], area[href]');
    if (!link) return;
    const href = link.getAttribute('href')!;
    if (href.trim().startsWith('#')) return;

    let destination: URL;
    try {
      destination = new URL(href, doc.baseURI);
    } catch {
      return;
    }
    if (destination.protocol !== 'https:' && destination.protocol !== 'http:') return;
    const current = new URL(doc.URL);
    if (destination.origin === current.origin && destination.pathname === current.pathname && destination.search === current.search) return;

    link.setAttribute('target', '_blank');
    const rel = new Set((link.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean));
    rel.add('noopener');
    rel.add('noreferrer');
    link.setAttribute('rel', [...rel].join(' '));
  };

  doc.addEventListener('click', prepareLink, true);
  doc.addEventListener('auxclick', prepareLink, true);
  doc.addEventListener('contextmenu', prepareLink, true);
}
