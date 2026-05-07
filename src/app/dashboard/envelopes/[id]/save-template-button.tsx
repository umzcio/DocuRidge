'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveAsTemplateAction, type SaveTemplateState } from './template-actions';
import { useEscape } from '@/lib/use-escape';

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
  useEscape(() => setOpen(false), open);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
      >
        Save as template
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4" role="dialog" aria-modal="true" aria-labelledby="save-template-title">
          <form action={formAction} className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl space-y-3">
            <input type="hidden" name="envelopeId" value={envelopeId} />
            <h2 id="save-template-title" className="text-base font-semibold">Save as template</h2>
            <p className="text-sm text-neutral-700">
              Captures the documents, fields, and recipient roles. Recipient emails are dropped — fill them in when you instantiate.
            </p>
            <label className="block text-sm">
              <span className="block font-medium text-neutral-700">Template title</span>
              <input
                name="title"
                required
                defaultValue={suggestedTitle}
                className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              />
            </label>
            {state.error && (
              <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
                {state.error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100">
                Cancel
              </button>
              <SubmitButton />
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-accent px-4 text-[13px] font-medium text-white border border-accent-deep hover:bg-accent-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save template'}
    </button>
  );
}
