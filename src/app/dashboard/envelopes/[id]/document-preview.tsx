'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Sender-side document preview. Fetches the envelope's first PDF and renders
 * each page to a canvas via pdfjs. Mirrors the recipient's view from the
 * signing ceremony (`/sign/[token]/document-view.tsx`) but routes through
 * the dashboard auth.
 */
export function DocumentPreview({ envelopeId, title }: { envelopeId: string; title: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/DocuRidge/pdf.worker.mjs';
        const url = `/DocuRidge/dashboard/envelopes/${encodeURIComponent(envelopeId)}/document`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Document fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const doc = await pdfjs.getDocument({ data: buf }).promise;
        if (cancelled) return;
        setPageCount(doc.numPages);
        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = '';
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const baseVp = page.getViewport({ scale: 1 });
          const targetWidth = container.clientWidth || 600;
          const scale = Math.min(2.5, targetWidth / baseVp.width);
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          canvas.style.display = 'block';
          canvas.style.marginBottom = '8px';
          canvas.setAttribute('aria-label', `${title} — page ${i} of ${doc.numPages}`);
          canvas.setAttribute('role', 'img');
          container.appendChild(canvas);
          const ctx = canvas.getContext('2d');
          if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load document');
      }
    })();
    return () => { cancelled = true; };
  }, [envelopeId, title]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12.5px] text-ink-tertiary">
          {pageCount > 0 ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : 'Loading document…'}
        </p>
        <a
          href={`/DocuRidge/dashboard/envelopes/${encodeURIComponent(envelopeId)}/document`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12.5px] text-accent font-medium hover:text-accent-deep"
        >
          Open in new tab →
        </a>
      </div>
      {error ? (
        <div role="alert" className="rounded-md border border-status-declined-border bg-status-declined-bg px-3 py-2 text-[12.5px] text-status-declined">
          {error}
        </div>
      ) : (
        <div
          ref={containerRef}
          role="region"
          aria-label={`Document preview: ${title}`}
          className="max-h-[680px] overflow-y-auto rounded-md border border-hairline bg-surface-muted/30 p-3"
        />
      )}
    </div>
  );
}
