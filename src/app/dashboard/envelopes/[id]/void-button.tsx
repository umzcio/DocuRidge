'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { voidEnvelopeAction, type VoidActionState } from './actions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const initial: VoidActionState = { ok: false };

export function VoidEnvelopeButton({ envelopeId }: { envelopeId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(voidEnvelopeAction, initial);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center rounded-md border border-destructive-border px-3 text-sm font-medium text-destructive hover:bg-destructive-bg"
      >
        Void document
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void this document?</DialogTitle>
            <DialogDescription>
              This stops the signing flow. Recipients who haven&apos;t signed yet will see a &quot;document is no longer awaiting your signature&quot; message. The action is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <form action={formAction} className="px-5 py-4 space-y-3">
            <input type="hidden" name="envelopeId" value={envelopeId} />
            <label className="block text-sm">
              <span className="block font-medium text-foreground">Reason</span>
              <textarea name="reason" required rows={3} className="mt-1 block w-full rounded-md border border-input px-3 py-2 text-sm" />
            </label>
            {state.error && (
              <div role="alert" className="rounded-md border border-destructive-border bg-destructive-bg p-3 text-sm text-destructive">
                {state.error}
              </div>
            )}
            <DialogFooter className="px-0 py-0">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted">
                Cancel
              </button>
              <SubmitButton />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
    >
      {pending ? 'Voiding…' : 'Void document'}
    </button>
  );
}
