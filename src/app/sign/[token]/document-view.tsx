'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchDocumentBytes } from '@/lib/documents/fetch-document';
import { DOCUMENT_LOAD_FAILED_MESSAGE } from '@/lib/documents/messages';

interface PageDims {
  width: number;
  height: number;
  loaded: boolean;
}

/**
 * Renders the signing recipient's document page-by-page with pdfjs and exposes
 * a render-prop for overlays positioned in fractional (0–1) coordinates per
 * page. Overlays are how the signing ceremony shows recipient-facing field
 * markers (Sign here, Initial, Date, etc.) directly on the document.
 *
 * Renders to React-managed canvases (instead of imperatively appending) so
 * the parent can render absolutely-positioned overlay elements on top of each
 * page using each canvas's measured dimensions.
 *
 * A document that cannot be shown shows the server's fixed text (a busy
 * server is waited out a few times first; see fetchDocumentBytes) and is
 * reported through `onUnavailable`, so the ceremony can refuse to submit a
 * signature for a document the signer could not see.
 */
export function DocumentView({
  token,
  itemId,
  title,
  renderPageOverlay,
  onUnavailable,
}: {
  token: string;
  /** Envelope item to show; the signing route serves the first when omitted. */
  itemId?: string;
  title: string;
  renderPageOverlay?: (pageNum: number, dims: { width: number; height: number }) => React.ReactNode;
  /** Called once if this document cannot be shown. */
  onUnavailable?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<HTMLCanvasElement[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [pages, setPages] = useState<PageDims[]>([]);
  const [error, setError] = useState<string | null>(null);
  const documentUrl = `/DocuRidge/sign/${encodeURIComponent(token)}/document${
    itemId ? `?item=${encodeURIComponent(itemId)}` : ''
  }`;
  // Read through a ref so a parent re-render does not refetch the document.
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  // Two-phase render: (1) fetch + parse the PDF and learn the page count
  // here; (2) render each page when its canvas ref is set, below.
  useEffect(() => {
    let canceled = false;
    const fail = (message: string) => {
      if (canceled) return;
      setError(message);
      onUnavailableRef.current?.();
    };
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/DocuRidge/pdf.worker.mjs';
        const fetched = await fetchDocumentBytes(documentUrl);
        if (canceled) return;
        if (!fetched.ok) return fail(fetched.message);
        const buf = fetched.bytes;
        const doc = await pdfjs.getDocument({ data: buf }).promise;
        if (canceled) return;
        setPageCount(doc.numPages);
        setPages(Array.from({ length: doc.numPages }, () => ({ width: 0, height: 0, loaded: false })));

        const targetWidth = containerRef.current?.clientWidth ?? 600;
        for (let i = 1; i <= doc.numPages; i++) {
          if (canceled) return;
          const page = await doc.getPage(i);
          const baseVp = page.getViewport({ scale: 1 });
          const scale = Math.min(2.5, targetWidth / baseVp.width);
          const vp = page.getViewport({ scale });
          // Wait for the canvas ref to be set by React; tiny micro-task pause.
          await new Promise((r) => setTimeout(r, 0));
          const canvas = canvasRefs.current[i - 1];
          if (!canvas) continue;
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.setAttribute('aria-label', `${title} — page ${i} of ${doc.numPages}`);
          canvas.setAttribute('role', 'img');
          const ctx = canvas.getContext('2d');
          if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
          setPages((cur) => {
            const next = cur.slice();
            next[i - 1] = { width: vp.width, height: vp.height, loaded: true };
            return next;
          });
        }
      } catch {
        // pdf.js's own text is never shown.
        fail(DOCUMENT_LOAD_FAILED_MESSAGE);
      }
    })();
    return () => { canceled = true; };
  }, [documentUrl, title]);

  if (error) {
    return (
      <div role="alert" className="rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-[12.5px] text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-[12px] text-faint">
          {pageCount > 0 ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : 'Loading document…'}
        </span>
        <a
          href={documentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12px] text-primary font-medium hover:text-primary-deep"
        >
          Open in new tab →
        </a>
      </div>
      <div
        ref={containerRef}
        role="region"
        aria-label={`Document preview: ${title}`}
        className="max-h-[78vh] overflow-y-auto rounded-md border border-border bg-muted/30 p-2 sm:p-3 space-y-2"
      >
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNum) => {
          const dims = pages[pageNum - 1];
          return (
            <div key={pageNum} className="relative mx-auto bg-white shadow-[0_2px_8px_rgba(15,17,21,0.06)]">
              <canvas
                ref={(el) => {
                  if (el) canvasRefs.current[pageNum - 1] = el;
                }}
                className="block w-full h-auto"
                aria-label={`${title} — page ${pageNum}`}
                role="img"
              />
              {dims?.loaded && renderPageOverlay && (
                <div className="absolute inset-0 pointer-events-none">
                  {renderPageOverlay(pageNum, { width: dims.width, height: dims.height })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
