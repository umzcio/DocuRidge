'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner } from '@/components/ui/banner';
import { setupAction, type SetupActionState } from './actions';

const initial: SetupActionState = { ok: false };

export function SetupForm() {
  const [state, formAction] = useActionState(setupAction, initial);
  if (state.ok && state.message) {
    return (
      <Banner tone="success" role="alert">
        {state.message}{' '}
        <Link href="/login" className="font-medium underline underline-offset-2 decoration-1 hover:decoration-2 ml-1">
          Sign in
        </Link>
      </Banner>
    );
  }
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <div>
        <label htmlFor="bootstrapToken" className="block text-meta font-medium text-ink mb-1.5">
          Bootstrap token
        </label>
        <Input
          id="bootstrapToken"
          name="bootstrapToken"
          type="password"
          autoComplete="off"
          required
          className="font-mono"
        />
        <p className="mt-1.5 text-[12px] text-ink-tertiary">
          Generated on first boot; stored in <span className="font-mono">.env</span>.
        </p>
      </div>
      <div>
        <label htmlFor="password" className="block text-meta font-medium text-ink mb-1.5">
          Administrator password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
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
      {pending ? 'Setting up…' : 'Complete setup'}
    </Button>
  );
}
