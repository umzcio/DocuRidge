'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { forwardCompletedAction, type ForwardActionState } from './actions';
import { Select } from '@/components/ui/select';
import { useEscape } from '@/lib/use-escape';

const initial: ForwardActionState = { ok: false };

/**
 * Detail-page button that opens an inline form for forwarding a completed
 * envelope to additional email addresses. Server action mints a single
 * share token shared across all recipients; expiration defaults to 30 days.
 */
export function ForwardButton({ envelopeId }: { envelopeId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(forwardCompletedAction, initial);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEscape(() => setOpen(false), open);

  useEffect(() => {
    if (state.ok) {
      // Auto-close on success after a beat so the toast can render.
      const t = setTimeout(() => setOpen(false), 1500);
      return () => clearTimeout(t);
    }
  }, [state]);

  // Close on outside click while the dialog is open.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-muted/60 transition-colors"
        title="Forward the sealed PDF to additional emails"
      >
        <ForwardIcon /> Forward
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Forward sealed PDF" className="fixed inset-0 z-50 bg-canvas/40 backdrop-blur-sm flex items-center justify-center px-4 py-8">
          <div ref={dialogRef} className="w-full max-w-[460px] rounded-lg border border-hairline bg-surface shadow-[0_24px_48px_rgba(15,17,21,0.18)]">
            <div className="px-5 pt-5 pb-3 border-b border-hairline">
              <h2 className="text-[16px] font-semibold text-ink">Forward sealed PDF</h2>
              <p className="mt-1 text-[12.5px] text-ink-secondary">
                Generate a view-only link and send it via email. Each link is single-token but works for everyone you list.
              </p>
            </div>
            <form action={action} className="px-5 py-4 space-y-4">
              <input type="hidden" name="envelopeId" value={envelopeId} />
              <label className="block">
                <span className="block text-[12px] font-medium text-ink-secondary mb-1">Recipients</span>
                <textarea
                  name="emails"
                  rows={3}
                  required
                  placeholder="finance@example.com, hr@example.com"
                  className="w-full px-3 py-2 rounded-md border border-hairline bg-surface text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
                />
                <span className="mt-1 block text-[11px] text-ink-tertiary">Separate addresses with commas, semicolons, or newlines. Up to 25 recipients.</span>
              </label>
              <label className="block">
                <span className="block text-[12px] font-medium text-ink-secondary mb-1">Note <span className="text-ink-tertiary font-normal">(optional)</span></span>
                <textarea
                  name="note"
                  rows={2}
                  maxLength={1000}
                  placeholder="A short message — appears at the top of the email."
                  className="w-full px-3 py-2 rounded-md border border-hairline bg-surface text-[13px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
                />
              </label>
              <label className="block">
                <span className="block text-[12px] font-medium text-ink-secondary mb-1">Link expires in</span>
                <ExpiresPicker />
              </label>
              {state.error && (
                <p className="text-[12px] text-status-declined">{state.error}</p>
              )}
              {state.ok && state.success && (
                <p className="text-[12px] text-status-completed">✓ {state.success}</p>
              )}
              <div className="pt-2 border-t border-hairline flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 items-center px-3 rounded-md border border-hairline bg-surface text-[13px] font-medium text-ink hover:bg-surface-muted/60"
                >
                  Close
                </button>
                <SendBtn />
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function SendBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center px-4 rounded-md bg-accent text-[13px] font-medium text-white border border-accent-deep hover:bg-accent-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Sending…' : 'Send forward'}
    </button>
  );
}

function ForwardIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" /></svg>);
}

function ExpiresPicker() {
  const [v, setV] = useState('30');
  return (
    <Select
      value={v}
      onChange={setV}
      name="expiresInDays"
      ariaLabel="Link expires in"
      options={[
        { value: '7',   label: '7 days' },
        { value: '14',  label: '14 days' },
        { value: '30',  label: '30 days' },
        { value: '90',  label: '90 days' },
        { value: '365', label: '1 year' },
      ]}
    />
  );
}
