'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { setupAction, type SetupActionState } from './actions';

const initial: SetupActionState = { ok: false };

export function SetupForm() {
  const [state, formAction] = useActionState(setupAction, initial);
  if (state.ok && state.message) {
    return (
      <div role="alert" className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800">
        {state.message} <Link href="/login" className="font-medium underline">Sign in</Link>.
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div>
        <label htmlFor="bootstrapToken" className="block text-sm font-medium text-neutral-700">
          Bootstrap token
        </label>
        <input
          id="bootstrapToken"
          name="bootstrapToken"
          type="password"
          autoComplete="off"
          required
          className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm font-mono"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-neutral-700">
          Administrator password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm"
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
      {pending ? 'Setting up…' : 'Complete setup'}
    </button>
  );
}
