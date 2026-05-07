'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { sendReminderAction, type ReminderActionState } from './actions';

const initial: ReminderActionState = { ok: false };

export function SendReminderButton({ envelopeId }: { envelopeId: string }) {
  const [state, formAction] = useActionState(sendReminderAction, initial);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (state.ok && state.messageText) setFeedback({ ok: true, text: state.messageText });
    else if (!state.ok && state.error) setFeedback({ ok: false, text: state.error });
  }, [state]);
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3500);
    return () => clearTimeout(t);
  }, [feedback]);

  return (
    <form action={formAction} className="inline-flex">
      <input type="hidden" name="envelopeId" value={envelopeId} />
      <SubmitBtn />
      {feedback && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-md border px-4 py-3 shadow-[0_8px_24px_rgba(15,17,21,0.12)] flex items-start gap-2 ${
            feedback.ok
              ? 'border-status-completed-border bg-status-completed-bg text-status-completed'
              : 'border-status-declined-border bg-status-declined-bg text-status-declined'
          }`}
        >
          <span className="mt-0.5">{feedback.ok ? <Check /> : <Alert />}</span>
          <p className="flex-1 text-[12.5px] leading-snug">{feedback.text}</p>
          <button type="button" onClick={() => setFeedback(null)} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
            <X />
          </button>
        </div>
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
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-muted/60 transition-colors disabled:opacity-50"
    >
      <Bell /> {pending ? 'Sending…' : 'Send reminder'}
    </button>
  );
}

function Bell() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>); }
function Check() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>); }
function Alert() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>); }
function X() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>); }
