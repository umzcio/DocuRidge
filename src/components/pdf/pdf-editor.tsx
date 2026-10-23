'use client';

import React, { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { applyPdfEdits, remapFieldsForPages, type PdfPageEdit, type PdfAnnotation } from '@/lib/pdf/edit';
import { PdfPreview } from './pdf-preview';

const buttonClass = 'rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed';
type Box = { page: number; x: number; y: number; w: number; h: number };
type EditState = { pages: PdfPageEdit[]; annotations: PdfAnnotation[] };

export function PdfEditor({ file, pageCount, fields, onApply, onClose }: {
  file: File; pageCount: number; fields: Box[];
  onApply: (file: File, pages: PdfPageEdit[]) => void; onClose: () => void;
}) {
  const [state, setState] = useState<EditState>({ pages: Array.from({ length: pageCount }, (_, i) => ({ sourcePage: i + 1, rotation: 0 })), annotations: [] });
  const [history, setHistory] = useState<EditState[]>([]);
  const [selected, setSelected] = useState(0);
  const [tool, setTool] = useState<'select' | 'text' | 'highlight'>('select');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const current = state.pages[selected]!;
  const currentAnnotations = state.annotations.filter(a => a.page === selected + 1);
  const previewKey = JSON.stringify({ current, annotations: currentAnnotations });
  const [annotatedPreview, setAnnotatedPreview] = useState<{ key: string; file: File } | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (!currentAnnotations.length) { setPreviewPending(false); return; }
    setPreviewPending(true);
    void (async () => {
      const bytes = await applyPdfEdits(new Uint8Array(await file.arrayBuffer()), [current], currentAnnotations.map(a => ({ ...a, page: 1 })));
      if (!disposed) setAnnotatedPreview({ key: previewKey, file: new File([new Uint8Array(bytes)], file.name, { type: 'application/pdf' }) });
    })().catch(err => { if (!disposed) setError(err instanceof Error ? err.message : 'Unable to preview annotations.'); })
      .finally(() => { if (!disposed) setPreviewPending(false); });
    return () => { disposed = true; };
    // The key contains the selected source page, rotation and complete annotation data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, previewKey]);
  const useAnnotatedPreview = annotatedPreview?.key === previewKey;
  const previewFields = remapFieldsForPages(fields, state.pages).filter(f => f.page === selected + 1);

  function update(next: EditState) {
    setHistory(h => [...h.slice(-39), state]); setState(next); setError('');
  }
  function rotate(delta: number, all = false) {
    const transforms = state.pages.map((_, i) => ({ sourcePage: i + 1, rotation: all || i === selected ? (delta + 360) % 360 : 0 }));
    update({ pages: state.pages.map((p, i) => ({ ...p, rotation: (p.rotation + transforms[i]!.rotation) % 360 })), annotations: remapFieldsForPages(state.annotations, transforms) });
  }
  function move(delta: number) {
    const order = state.pages.map((_, i) => i);
    [order[selected], order[selected + delta]] = [order[selected + delta]!, order[selected]!];
    update({ pages: order.map(i => state.pages[i]!), annotations: remapFieldsForPages(state.annotations, order.map(i => ({ sourcePage: i + 1, rotation: 0 }))) });
    setSelected(selected + delta);
  }
  function remove() {
    const order = state.pages.map((_, i) => i).filter(i => i !== selected);
    update({ pages: order.map(i => state.pages[i]!), annotations: remapFieldsForPages(state.annotations, order.map(i => ({ sourcePage: i + 1, rotation: 0 }))) });
    setSelected(Math.min(selected, order.length - 1));
  }
  function point(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function place(event: PointerEvent<HTMLDivElement>) {
    const start = dragStart.current; dragStart.current = null;
    if (!start || tool === 'select') return;
    const end = point(event);
    if (tool === 'text') {
      if (!text.trim()) { setError('Enter the text to add, then click on the page.'); return; }
      update({ ...state, annotations: [...state.annotations, { page: selected + 1, kind: 'text', x: Math.min(start.x, 0.65), y: Math.min(start.y, 0.95), w: 0.35, h: 0.05, text: text.trim() }] });
    } else {
      const x = Math.min(start.x, end.x); const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x); const h = Math.abs(end.y - start.y);
      if (w < 0.005 || h < 0.005) { setError('Drag across the area you want to highlight.'); return; }
      update({ ...state, annotations: [...state.annotations, { page: selected + 1, kind: 'highlight', x, y, w, h }] });
    }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const bytes = await applyPdfEdits(new Uint8Array(await file.arrayBuffer()), state.pages, state.annotations);
      onApply(new File([new Uint8Array(bytes)], file.name, { type: 'application/pdf' }), state.pages);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save PDF edits.'); }
    finally { setBusy(false); }
  }
  const removedFields = fields.length - remapFieldsForPages(fields, state.pages).length;
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-[1100px] w-[calc(100vw-1rem)] flex flex-col overflow-hidden" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader><DialogTitle>Edit PDF</DialogTitle><DialogDescription>{file.name} · Changes apply to the PDF recipients will receive.</DialogDescription></DialogHeader>
        <div className="flex flex-wrap gap-2 p-3 border-b border-border">
          <button type="button" className={buttonClass} disabled={busy} onClick={() => rotate(-90)}>Rotate left</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => rotate(90)}>Rotate right</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => rotate(90, true)}>Rotate all</button>
          <button type="button" className={buttonClass} disabled={busy || selected === 0} onClick={() => move(-1)}>Move earlier</button>
          <button type="button" className={buttonClass} disabled={busy || selected === state.pages.length - 1} onClick={() => move(1)}>Move later</button>
          <button type="button" className={buttonClass} disabled={busy || state.pages.length === 1} onClick={remove}>Delete page</button>
          <button type="button" className={buttonClass} disabled={busy || !history.length} onClick={() => {
            const previous = history[history.length - 1]!; setState(previous); setHistory(h => h.slice(0, -1)); setSelected(i => Math.min(i, previous.pages.length - 1)); setError('');
          }}>Undo</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[170px_1fr] overflow-y-auto min-h-0">
          <aside className="p-3 border-r border-border space-y-2 max-sm:flex max-sm:gap-2 max-sm:overflow-x-auto">
            {state.pages.map((p, i) => <button type="button" key={p.sourcePage} disabled={busy} onClick={() => setSelected(i)} aria-current={selected === i ? 'page' : undefined} className={`${buttonClass} block w-full text-left ${selected === i ? 'ring-2 ring-primary' : ''}`}>
              Page {i + 1}<span className="block text-xs text-muted-foreground">Original {p.sourcePage} · {p.rotation}°</span>
            </button>)}
          </aside>
          <div className="p-3 bg-muted/40 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-sm mr-auto">Page {selected + 1} of {state.pages.length}</span>
              {(['select', 'text', 'highlight'] as const).map(t => <button type="button" key={t} className={buttonClass} disabled={busy} aria-pressed={tool === t} onClick={() => setTool(t)}>{t === 'select' ? 'View' : t === 'text' ? 'Add text' : 'Highlight'}</button>)}
            </div>
            {tool === 'text' && <label className="block text-sm mb-3">Text to add<input className="block w-full rounded border border-border bg-card p-2 mt-1" value={text} maxLength={200} onChange={e => setText(e.target.value)} placeholder="Enter text, then click on the page" /></label>}
            {tool === 'highlight' && <p className="text-sm mb-3">Drag across the page to add a highlight.</p>}
            {previewPending && <p role="status" className="text-sm mb-2">Updating annotation preview…</p>}
            <PdfPreview file={useAnnotatedPreview ? annotatedPreview.file : file} page={useAnnotatedPreview ? 1 : current.sourcePage} rotation={useAnnotatedPreview ? 0 : current.rotation}>
              <div className={`absolute inset-0 ${tool !== 'select' ? 'cursor-crosshair touch-none' : ''}`} data-editor-page onPointerDown={e => { if (busy || previewPending || tool === 'select') return; dragStart.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerUp={place} onPointerCancel={() => { dragStart.current = null; }}>
                {previewFields.map((f, i) => <div key={i} className="absolute border border-dashed border-blue-600 bg-blue-100/30 pointer-events-none" style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }} />)}

              </div>
            </PdfPreview>
            {state.annotations.some(a => a.page === selected + 1) && <button type="button" className={`${buttonClass} mt-3`} disabled={busy} onClick={() => update({ ...state, annotations: state.annotations.filter(a => a.page !== selected + 1) })}>Clear annotations on this page</button>}
          </div>
        </div>
        {removedFields > 0 && <p role="status" className="px-5 pt-2 text-sm">Applying these edits will remove {removedFields} field{removedFields === 1 ? '' : 's'} from deleted pages.</p>}
        {error && <p role="alert" className="px-5 pt-2 text-sm text-destructive">{error}</p>}
        <DialogFooter><button type="button" className={buttonClass} disabled={busy} onClick={onClose}>Cancel</button><button type="button" className={`${buttonClass} bg-primary text-primary-foreground`} disabled={busy || history.length === 0} onClick={() => void apply()}>{busy ? 'Applying…' : 'Apply changes'}</button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
