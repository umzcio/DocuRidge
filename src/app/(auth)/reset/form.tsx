'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { requestResetAction, type ResetRequestState } from './actions';

const initial: ResetRequestState = { ok: false };

export function ResetRequestForm() {
  const [state, formAction] = useActionState(requestResetAction, initial);
  if (state.ok && state.message) {
    return (
      <div role="alert" className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800">
        {state.message}
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-neutral-700">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm"
          aria-invalid={state.error ? 'true' : 'false'}
        />
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
      {pending ? 'Sending…' : 'Send reset link'}
    </button>
  );
}
