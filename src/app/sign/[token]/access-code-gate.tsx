'use client';

import { useActionState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { verifyRecipientAccessCodeAction } from './actions';

/**
 * Access-code form shown INSTEAD of the ceremony while the recipient's code
 * is unproven. It deliberately receives nothing but the token (already in the
 * URL): the page renders no envelope data until the server sees a valid
 * unlock proof. On success the action has set the proof cookie, so a refresh
 * re-renders the page server-side with the full ceremony.
 */
export function AccessCodeGate({ token }: { token: string }) {
  const router = useRouter();
  const [state, formAction] = useActionState(verifyRecipientAccessCodeAction, { ok: false });
  useEffect(() => { if (state.ok) router.refresh(); }, [state.ok, router]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="bg-card border-b border-border px-6 lg:px-8 h-14 flex items-center gap-4">
        <p className="text-[15px] font-semibold tracking-[-0.012em] text-foreground truncate">DocuRidge</p>
      </header>
      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <form action={formAction} className="w-full max-w-xl rounded-lg border border-border bg-card p-6 sm:p-8">
          <input type="hidden" name="token" value={token} />
          <span className="inline-flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-[0.08em] text-primary">
            <LockIcon /> Access code required
          </span>
          <h1 className="mt-2 text-[22px] sm:text-[26px] font-semibold tracking-[-0.022em] text-foreground">
            Enter your access code
          </h1>
          <p className="mt-2 text-[13.5px] text-muted-foreground">
            The sender protected this document with an access code. Enter the code they shared with you to continue.
          </p>
          <input
            name="code"
            autoFocus
            autoComplete="off"
            aria-label="Access code"
            placeholder="e.g. K7P2QX"
            className="mt-5 block w-full h-11 px-3.5 rounded-md border border-input bg-card text-[15px] font-mono tracking-[0.12em] text-foreground placeholder:text-faint outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
            aria-invalid={!!state.error}
          />
          {state.error && (
            <div role="alert" className="mt-4 rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-[12.5px] text-destructive">
              {state.error}
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <UnlockSubmit unlocked={state.ok} />
          </div>
        </form>
      </main>
    </div>
  );
}

function UnlockSubmit({ unlocked }: { unlocked: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || unlocked}
      className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-5 text-[13.5px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {pending ? 'Checking…' : unlocked ? 'Opening…' : (<>Unlock document <ChevronRight /></>)}
    </button>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
