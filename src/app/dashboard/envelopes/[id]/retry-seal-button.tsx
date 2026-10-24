'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { retrySealingAction, type ReminderActionState } from './actions';

const initial: ReminderActionState = { ok: false };

/** Retry sealing an envelope whose signers are all done (see retryEnvelopeSealing). */
export function RetrySealButton({ envelopeId }: { envelopeId: string }) {
  const [state, formAction] = useActionState(retrySealingAction, initial);
  return (
    <form action={formAction} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="envelopeId" value={envelopeId} />
      <SubmitBtn />
      {state.ok && state.messageText && (
        <p role="status" className="text-[12.5px]">{state.messageText}</p>
      )}
      {!state.ok && state.error && (
        <p role="alert" className="text-[12.5px]">{state.error}</p>
      )}
    </form>
  );
}

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
    >
      {pending ? 'Sealing…' : 'Retry sealing'}
    </button>
  );
}
