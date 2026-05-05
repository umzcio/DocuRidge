'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Renders the signing recipient's document inline using pdfjs canvases.
 *
 * This replaces the previous iframe approach: mobile browsers (iOS Safari,
 * Chrome on Android) do not embed PDFs in iframes, so the recipient on a
 * phone would see a blank box. Rendering each page to a canvas works
 * everywhere AND lets us avoid pinch-zoom (R-4: pages render to fit width).
 */
export function DocumentView({ token, title }: { token: string; title: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/DocuRidge/pdf.worker.mjs';
        const url = `/DocuRidge/sign/${encodeURIComponent(token)}/document`;
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
          if (ctx) {
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load document');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token, title]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-xs text-neutral-500">
          {pageCount > 0 ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : 'Loading document…'}
        </span>
        <a
          href={`/DocuRidge/sign/${encodeURIComponent(token)}/document`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent-700 underline underline-offset-2"
        >
          Open in new tab
        </a>
      </div>
      {error ? (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      ) : (
        <div
          ref={containerRef}
          role="region"
          aria-label={`Document preview: ${title}`}
          className="max-h-[70vh] overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-2"
        />
      )}
    </div>
  );
}
