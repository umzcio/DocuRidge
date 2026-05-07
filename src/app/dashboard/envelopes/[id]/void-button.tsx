'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { voidEnvelopeAction, type VoidActionState } from './actions';
import { useEscape } from '@/lib/use-escape';

const initial: VoidActionState = { ok: false };

export function VoidEnvelopeButton({ envelopeId }: { envelopeId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(voidEnvelopeAction, initial);
  useEscape(() => setOpen(false), open);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center rounded-md border border-red-300 px-3 text-sm font-medium text-red-800 hover:bg-red-50"
      >
        Void document
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4" role="dialog" aria-modal="true" aria-labelledby="void-title">
          <form action={formAction} className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl space-y-3">
            <input type="hidden" name="envelopeId" value={envelopeId} />
            <h2 id="void-title" className="text-base font-semibold">Void this document?</h2>
            <p className="text-sm text-neutral-700">
              This stops the signing flow. Recipients who haven&apos;t signed yet will see a &quot;document is no longer awaiting your signature&quot; message. The action is recorded in the audit log.
            </p>
            <label className="block text-sm">
              <span className="block font-medium text-neutral-700">Reason</span>
              <textarea name="reason" required rows={3} className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm" />
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
      className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
    >
      {pending ? 'Voiding…' : 'Void document'}
    </button>
  );
}
