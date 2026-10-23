'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveAsTemplateAction, type SaveTemplateState } from './template-actions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const initial: SaveTemplateState = { ok: false };

export function SaveAsTemplateButton({
  envelopeId,
  suggestedTitle,
}: {
  envelopeId: string;
  suggestedTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(saveAsTemplateAction, initial);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
      >
        Save as template
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
            <DialogDescription>
              Captures the documents, fields, and recipient roles. Recipient emails are dropped — fill them in when you instantiate.
            </DialogDescription>
          </DialogHeader>
          <form action={formAction} className="px-5 py-4 space-y-3">
            <input type="hidden" name="envelopeId" value={envelopeId} />
            <label className="block text-sm">
              <span className="block font-medium text-foreground">Template title</span>
              <input
                name="title"
                required
                defaultValue={suggestedTitle}
                className="mt-1 block w-full rounded-md border border-input px-3 py-2 text-sm"
              />
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
      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save template'}
    </button>
  );
}
