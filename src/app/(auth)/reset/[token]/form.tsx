'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { completeResetAction, type ResetCompleteState } from './actions';

const initial: ResetCompleteState = { ok: false };

export function ResetCompleteForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(completeResetAction, initial);
  if (state.ok && state.message) {
    return (
      <div role="alert" className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800">
        {state.message} <Link href="/login" className="font-medium underline">Return to sign in</Link>.
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-neutral-700">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm"
          aria-invalid={state.fieldErrors?.password ? 'true' : 'false'}
        />
        {state.fieldErrors?.password && (
          <p className="mt-1 text-sm text-red-700">{state.fieldErrors.password}</p>
        )}
      </div>
      {state.error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
      )}
      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Set new password'}
    </button>
  );
}
