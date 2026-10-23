'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { forwardCompletedAction, type ForwardActionState } from './actions';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const initial: ForwardActionState = { ok: false };

/**
 * Detail-page button that opens an inline form for forwarding a completed
 * envelope to additional email addresses. Server action mints a single
 * share token shared across all recipients; expiration defaults to 30 days.
 */
export function ForwardButton({ envelopeId }: { envelopeId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(forwardCompletedAction, initial);

  useEffect(() => {
    if (state.ok) {
      // Auto-close on success after a beat so the toast can render.
      const t = setTimeout(() => setOpen(false), 1500);
      return () => clearTimeout(t);
    }
  }, [state]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground hover:bg-muted/60 transition-colors"
        title="Forward the sealed PDF to additional emails"
      >
        <ForwardIcon /> Forward
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forward sealed PDF</DialogTitle>
            <DialogDescription>
              Generate a view-only link and send it via email. Each link is single-token but works for everyone you list.
            </DialogDescription>
          </DialogHeader>
          <form action={action} className="px-5 py-4 space-y-4">
            <input type="hidden" name="envelopeId" value={envelopeId} />
            <label className="block">
              <span className="block text-[12px] font-medium text-muted-foreground mb-1">Recipients</span>
              <textarea
                name="emails"
                rows={3}
                required
                placeholder="finance@example.com, hr@example.com"
                className="w-full px-3 py-2 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12 resize-none"
              />
              <span className="mt-1 block text-[11px] text-faint">Separate addresses with commas, semicolons, or newlines. Up to 25 recipients.</span>
            </label>
            <label className="block">
              <span className="block text-[12px] font-medium text-muted-foreground mb-1">Note <span className="text-faint font-normal">(optional)</span></span>
              <textarea
                name="note"
                rows={2}
                maxLength={1000}
                placeholder="A short message — appears at the top of the email."
                className="w-full px-3 py-2 rounded-md border border-border bg-card text-[13px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12 resize-none"
              />
            </label>
            <label className="block">
              <span className="block text-[12px] font-medium text-muted-foreground mb-1">Link expires in</span>
              <ExpiresPicker />
            </label>
            {state.error && (
              <p className="text-[12px] text-destructive">{state.error}</p>
            )}
            {state.ok && state.success && (
              <p className="text-[12px] text-success">✓ {state.success}</p>
            )}
            <DialogFooter className="px-0 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-foreground hover:bg-muted/60"
              >
                Close
              </button>
              <SendBtn />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SendBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-50"
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
