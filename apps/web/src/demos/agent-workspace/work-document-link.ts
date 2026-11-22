import type { GenericDocument } from '../document-query/document-model';

export function sourceUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    // The connector has no usable source link.
  }
}

export function workDocumentHref(doc: { id: string; sourceUrl?: string }) {
  return (
    sourceUrl(doc.sourceUrl) ??
    '/agent.html?source-document=' + encodeURIComponent(doc.id)
  );
}

export function progressDocumentHref(
  doc: GenericDocument & { workDocumentId?: string },
) {
  const external = sourceUrl(doc.sourceUrl);
  if (external) return external;
  if (
    doc.workDocumentId === doc.id &&
    doc.key === `work/${doc.typeId}/${doc.id}`
  ) {
    const query = new URLSearchParams({
      'source-document': doc.id,
      'progress-key': doc.key,
      'source-system': doc.source.id,
    });
    return '/agent.html?' + query;
  }
  return '/agent.html?progress-source=' + encodeURIComponent(doc.key);
}
