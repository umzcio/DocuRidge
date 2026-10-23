'use client';

import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export async function openBrowserPdf(file: File): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/DocuRidge/pdf.worker.mjs';
  return pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
}

/** The canvas defines the overlay's geometry, including crop boxes and intrinsic rotation. */
export function PdfPreview({ file, page, rotation = 0, children }: {
  file: File; page: number; rotation?: number; children?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let pdf: PDFDocumentProxy | undefined;
    let task: RenderTask | undefined;
    setLoaded(false); setError('');
    void (async () => {
      pdf = await openBrowserPdf(file);
      if (disposed) return;
      const source = await pdf.getPage(page);
      const base = source.getViewport({ scale: 1, rotation: (source.rotate + rotation + 360) % 360 });
      const viewport = source.getViewport({ scale: Math.min(2, 1400 / Math.max(base.width, base.height)), rotation: base.rotation });
      const canvas = canvasRef.current;
      if (disposed || !canvas) return;
      canvas.width = viewport.width; canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('PDF preview is unavailable in this browser.');
      task = source.render({ canvasContext: context, viewport });
      await task.promise;
      if (!disposed) setLoaded(true);
    })().catch(err => { if (!disposed) setError(err instanceof Error ? err.message : 'Unable to render page.'); })
      .finally(() => { void pdf?.destroy(); });
    return () => { disposed = true; task?.cancel(); void pdf?.destroy(); };
  }, [file, page, rotation]);
  return (
    <div className="w-full">
      {error && <p role="alert" className="p-4 text-sm text-destructive">{error}</p>}
      {!loaded && !error && <p role="status" className="p-4 text-sm text-muted-foreground">Loading page…</p>}
      <div className="relative bg-white shadow-sm" data-pdf-preview data-loaded={loaded} style={{ display: error ? 'none' : undefined }}>
        <canvas ref={canvasRef} aria-label={`PDF page ${page}`} className="block w-full h-auto" />
        {loaded && children}
      </div>
    </div>
  );
}
