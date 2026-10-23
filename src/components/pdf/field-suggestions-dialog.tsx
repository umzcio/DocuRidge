'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { filterDuplicateSuggestions, SUGGESTION_TYPES, type FieldSuggestion } from '@/lib/ai/field-suggestions';
import { detectSigningLines, refineSignaturePlacement } from '@/lib/ai/signature-placement';
import { detectCheckboxes, refineCheckboxPlacement } from '@/lib/ai/checkbox-placement';
import { openBrowserPdf, PdfPreview } from './pdf-preview';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const buttonClass = 'rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed';
const inputClass = 'w-full rounded border border-border bg-card px-2 py-1 text-sm';
export type ReviewedSuggestion = FieldSuggestion & { recipientClientId: string; required: boolean };
type Candidate = ReviewedSuggestion & { id: string; selected: boolean };
type ExistingField = { page: number; type: string; x: number; y: number; w: number; h: number };
type Recipient = { clientId: string; name: string; email: string; role: string };
const labelFor = (type: string) => type.toLowerCase().replaceAll('_', ' ');

export function FieldSuggestionsDialog({ file, pageCount, existingFields, recipients, activeRecipientId, onApply, onClose, onAddSigner }: {
  file: File; pageCount: number; existingFields: ExistingField[]; recipients: Recipient[]; activeRecipientId?: string | null;
  onApply: (fields: ReviewedSuggestion[]) => void; onClose: () => void;
  onAddSigner?: (name: string, email: string) => string;
}) {
  const eligible = recipients.filter(r => r.role !== 'CC' && r.role !== 'APPROVER' && r.role !== 'VIEWER');
  const defaultRecipient = eligible.find(r => r.clientId === activeRecipientId)?.clientId ?? eligible[0]?.clientId ?? '';
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [completed, setCompleted] = useState<number[]>([]);
  const [failed, setFailed] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [signerError, setSignerError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const check = new AbortController();
    void fetch('/DocuRidge/api/ai/field-suggestions', { signal: check.signal, cache: 'no-store' }).then(async res => {
      if (!res.ok) throw new Error('Unable to check AI availability. Close this dialog and try again.');
      const data = await res.json();
      if (mounted.current) setEnabled(data.enabled === true);
    }).catch(err => { if (!check.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to check AI availability.'); });
    return () => { mounted.current = false; check.abort(); controller.current?.abort(); };
  }, []);
  async function analyze() {
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setFailed([]);
    const failures: number[] = [];
    let pdf: PDFDocumentProxy | undefined;
    let added = 0;
    try {
      pdf = await openBrowserPdf(file);
      const todo = Array.from({ length: pageCount }, (_, i) => i + 1).filter(p => !completed.includes(p));
      for (const pageNumber of todo) {
        if (abort.signal.aborted) break;
        setProgress(`Analyzing page ${pageNumber} of ${pageCount}…`);
        let pause = false;
        try {
          const source = await pdf.getPage(pageNumber);
          if (abort.signal.aborted) break;
          const base = source.getViewport({ scale: 1 });
          const viewport = source.getViewport({ scale: Math.min(2, 1600 / Math.max(base.width, base.height)) });
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Your browser could not render this PDF.');
          const render = source.render({ canvasContext: context, viewport });
          const cancelRender = () => render.cancel();
          abort.signal.addEventListener('abort', cancelRender, { once: true });
          try { await render.promise; } finally { abort.signal.removeEventListener('abort', cancelRender); }
          if (abort.signal.aborted) break;
          const content = await source.getTextContent();
          const text = content.items.filter(item => 'str' in item).map(item => {
            if (!('str' in item)) return '';
            const [x, y] = base.convertToViewportPoint(item.transform[4]!, item.transform[5]!);
            return `[x=${(x! / base.width).toFixed(3)},y=${(y! / base.height).toFixed(3)}] ${item.str}`;
          }).join('\n').slice(0, 24000);
          const image = canvas.toDataURL('image/jpeg', 0.8);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const signingLines = detectSigningLines(pixels);
          const checkboxBoxes = detectCheckboxes(pixels);
          canvas.width = 0; canvas.height = 0;
          const response = await fetch('/DocuRidge/api/ai/field-suggestions', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: pageNumber, image, text }) });
          const data = await response.json();
          if (!response.ok) {
            pause = [401, 403, 429, 503].includes(response.status);
            throw new Error(data.error || 'AI analysis failed.');
          }
          if (!mounted.current || abort.signal.aborted) break;
          const signatures = refineSignaturePlacement(data.suggestions as FieldSuggestion[], signingLines, existingFields);
          const refined = refineCheckboxPlacement(signatures, checkboxBoxes, existingFields);
          const fresh = filterDuplicateSuggestions(refined, existingFields);
          added += fresh.length;
          setCandidates(current => [...current, ...filterDuplicateSuggestions(fresh, current).map(s => ({ ...s, id: crypto.randomUUID(), selected: true, required: s.type === 'SIGNATURE' || s.type === 'INITIALS', recipientClientId: defaultRecipient }))]);
          setCompleted(current => [...new Set([...current, pageNumber])]);
          source.cleanup();
        } catch (err) {
          if (abort.signal.aborted) break;
          failures.push(pageNumber);
          if (mounted.current) setError(err instanceof Error ? err.message : 'AI analysis failed.');
          if (pause) break;
        }
      }
      if (mounted.current) {
        setFailed(failures);
        setProgress(abort.signal.aborted ? 'Analysis stopped. You can review results or continue analyzing.' : failures.length ? `Could not analyze page${failures.length === 1 ? '' : 's'} ${failures.join(', ')}. Review available results or retry.` : added ? 'Analysis complete. Review the suggested fields below.' : 'No new fields found. You can still place fields manually.');
      }
    } catch (err) {
      if (mounted.current && !abort.signal.aborted) setError(err instanceof Error ? err.message : 'Could not read the PDF.');
    } finally {
      await pdf?.destroy();
      if (mounted.current) setBusy(false);
    }
  }
  function change(id: string, patch: Partial<Candidate>) { setCandidates(current => current.map(c => c.id === id ? { ...c, ...patch } : c)); }
  const selected = candidates.filter(c => c.selected);
  const active = candidates.find(c => c.id === activeId) ?? null;
  const disabledReason = busy ? 'Wait for analysis to finish.' : !selected.length ? 'Select at least one suggested field.' : !eligible.length ? 'Add a signer below to enable adding fields.' : '';
  function addSigner(event: React.SyntheticEvent) {
    event.preventDefault(); event.stopPropagation();
    if (busy || !onAddSigner) return;
    const name = signerName.trim(), email = signerEmail.trim().toLowerCase();
    if (!name) { setSignerError('Enter the signer’s name.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setSignerError('Enter a valid email address.'); return; }
    if (recipients.some(r => r.email.toLowerCase() === email)) { setSignerError('That recipient already exists. Use a different signer or update their role in document preparation.'); return; }
    try {
      const recipientClientId = onAddSigner(name, email);
      setCandidates(current => current.map(c => c.recipientClientId ? c : { ...c, recipientClientId }));
      setSignerError(''); setSignerName(''); setSignerEmail('');
    } catch (err) { setSignerError(err instanceof Error ? err.message : 'Could not add the signer.'); }
  }
  function apply() {
    if (selected.some(c => !eligible.some(r => r.clientId === c.recipientClientId))) { setError('Assign each selected field to a recipient before adding it.'); return; }
    try { onApply(filterDuplicateSuggestions(selected, existingFields)); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not add these fields.'); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) { controller.current?.abort(); onClose(); } }}>
      <DialogContent className="max-w-[1100px] w-[calc(100vw-1rem)] flex flex-col overflow-hidden" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader><DialogTitle>AI: Suggest fields</DialogTitle><DialogDescription>Find possible signing and text fields in {file.name}. Review placement and recipients before adding them.</DialogDescription></DialogHeader>
        <div className="p-3 border-b border-border space-y-2">
          {enabled === false && <p className="text-sm">AI field detection is not configured. Ask your administrator to configure an AI service for DocuRidge.</p>}
          {enabled && <p className="text-xs text-muted-foreground">Analysis sends page images and text to your organization’s configured AI service when you click Analyze document.</p>}
          <div className="flex flex-wrap gap-2 items-center">
            <button type="button" className={buttonClass} disabled={!enabled || busy || completed.length === pageCount} onClick={() => void analyze()}>{failed.length ? 'Retry failed pages' : completed.length && completed.length < pageCount ? 'Continue analysis' : 'Analyze document'}</button>
            {busy && <button type="button" className={buttonClass} onClick={() => controller.current?.abort()}>Stop analysis</button>}
            <span role="status" aria-live="polite" className="text-sm">{enabled === null && !error ? 'Checking AI availability…' : progress}</span>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!eligible.length && <p className="text-sm">These fields need a signer. You can add one below and keep your suggestions.</p>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_320px] min-h-0 overflow-y-auto">
          <div className="bg-muted/40 p-3 min-w-0">
            <div className="flex items-center justify-between mb-3"><button type="button" className={buttonClass} disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous page</button><span className="text-sm">Page {page} of {pageCount}</span><button type="button" className={buttonClass} disabled={page === pageCount} onClick={() => setPage(p => p + 1)}>Next page</button></div>
            <PdfPreview file={file} page={page}>
              {candidates.filter(c => c.page === page).map((c, i) => <button type="button" key={c.id} aria-label={`Review ${c.label || labelFor(c.type)}`} onClick={() => setActiveId(c.id)} className={`absolute border-2 text-left overflow-hidden text-[10px] ${c.selected ? 'border-primary bg-blue-200/40 text-blue-950' : 'border-gray-500 border-dashed bg-gray-100/40 text-gray-800'} ${activeId === c.id ? 'ring-2 ring-offset-1 ring-primary' : ''}`} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}>{i + 1}. {c.label}</button>)}
            </PdfPreview>
          </div>
          <aside className="border-l border-border p-3 space-y-3">
            <p className="text-sm font-medium">{selected.length} selected · {candidates.length} suggestions</p>
            {candidates.length > 0 && <div className="flex gap-2"><button type="button" className={buttonClass} onClick={() => setCandidates(c => c.map(s => ({ ...s, selected: true })))}>Select all</button><button type="button" className={buttonClass} onClick={() => setCandidates(c => c.map(s => ({ ...s, selected: false })))}>Dismiss all</button></div>}
            {candidates.map(c => <div key={c.id} className={`rounded border p-2 ${c.id === activeId ? 'border-primary' : 'border-border'}`}>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={c.selected} onChange={e => change(c.id, { selected: e.target.checked })} aria-label={`Include ${c.label}`} /><button type="button" className="text-left flex-1" onClick={() => { setActiveId(c.id); setPage(c.page); }}>{c.label || labelFor(c.type)}<span className="block text-xs text-muted-foreground">Page {c.page} · {labelFor(c.type)} · {Math.round(c.confidence * 100)}% confidence</span></button></label>
            </div>)}
            {active && <div className="border-t border-border pt-3 space-y-3" aria-label="Suggestion properties">
              <label className="block text-xs">Field label<input className={inputClass} value={active.label} maxLength={120} onChange={e => change(active.id, { label: e.target.value })} /></label>
              <label className="block text-xs">Field type<select className={inputClass} value={active.type} onChange={e => change(active.id, { type: e.target.value as FieldSuggestion['type'] })}>{SUGGESTION_TYPES.map(t => <option key={t} value={t}>{labelFor(t)}</option>)}</select></label>
              <label className="block text-xs">Recipient<select className={inputClass} value={active.recipientClientId} onChange={e => change(active.id, { recipientClientId: e.target.value })}><option value="">Choose recipient</option>{eligible.map(r => <option key={r.clientId} value={r.clientId}>{r.name || r.email}</option>)}</select></label>
              <label className="flex gap-2 text-sm"><input type="checkbox" checked={active.required} onChange={e => change(active.id, { required: e.target.checked })} />Required field</label>
              <div className="grid grid-cols-2 gap-2">{(['x', 'y', 'w', 'h'] as const).map(key => <label key={key} className="text-xs">{({ x: 'Left', y: 'Top', w: 'Width', h: 'Height' })[key]} (%)<input type="number" step="0.5" min={key === 'w' || key === 'h' ? 0.5 : 0} max="100" className={inputClass} value={Math.round(active[key] * 1000) / 10} onChange={e => {
                const value = Number(e.target.value) / 100;
                if (!Number.isFinite(value)) return;
                const patch = { ...active, [key]: Math.max(key === 'w' || key === 'h' ? 0.005 : 0, Math.min(1, value)) };
                if (key === 'x') patch.x = Math.min(patch.x, 1 - patch.w);
                if (key === 'y') patch.y = Math.min(patch.y, 1 - patch.h);
                if (key === 'w') patch.w = Math.min(patch.w, 1 - patch.x);
                if (key === 'h') patch.h = Math.min(patch.h, 1 - patch.y);
                change(active.id, patch);
              }} /></label>)}</div>
            </div>}
          </aside>
        </div>
        <DialogFooter className="flex-col shrink-0 border-t border-border">
          {!eligible.length && onAddSigner && <div className="space-y-2">
            <p className="text-sm font-medium">Who will fill these fields?</p>
            <div className="flex flex-wrap gap-2 items-end">
              <label className="flex-1 min-w-0 text-xs">Signer name<input className={inputClass} value={signerName} onChange={e => setSignerName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addSigner(e); }} autoComplete="name" /></label>
              <label className="flex-1 min-w-0 text-xs">Signer email<input className={inputClass} type="email" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addSigner(e); }} autoComplete="email" /></label>
              <button type="button" className={buttonClass} disabled={busy} onClick={addSigner}>Add signer</button>
            </div>
            {signerError && <p role="alert" className="text-sm text-destructive">{signerError}</p>}
          </div>}
          {disabledReason && <p className="text-xs text-muted-foreground" id="ai-add-fields-reason">{disabledReason}</p>}
          <div className="flex justify-end gap-2"><button type="button" className={buttonClass} onClick={() => { controller.current?.abort(); onClose(); }}>Cancel</button><button type="button" className={`${buttonClass} bg-primary text-primary-foreground`} disabled={!!disabledReason} aria-describedby={disabledReason ? 'ai-add-fields-reason' : undefined} onClick={apply}>Add {selected.length} selected fields</button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
