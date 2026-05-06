'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner } from '@/components/ui/banner';
import { completeResetAction, type ResetCompleteState } from './actions';

const initial: ResetCompleteState = { ok: false };

export function ResetCompleteForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(completeResetAction, initial);
  if (state.ok && state.message) {
    return (
      <Banner tone="success" role="alert">
        {state.message}{' '}
        <Link href="/login" className="font-medium underline underline-offset-2 decoration-1 hover:decoration-2 ml-1">
          Return to sign in
        </Link>
      </Banner>
    );
  }
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="password" className="block text-meta font-medium text-ink mb-1.5">
          New password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={state.fieldErrors?.password ? 'true' : 'false'}
        />
        {state.fieldErrors?.password && (
          <p className="mt-1.5 text-meta text-status-declined">{state.fieldErrors.password}</p>
        )}
      </div>
      {state.error && <Banner tone="error" role="alert">{state.error}</Banner>}
      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="lg" className="w-full">
      {pending ? 'Saving…' : 'Set new password'}
    </Button>
  );
}
