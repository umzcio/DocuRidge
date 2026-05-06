'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner } from '@/components/ui/banner';
import { requestResetAction, type ResetRequestState } from './actions';

const initial: ResetRequestState = { ok: false };

export function ResetRequestForm() {
  const [state, formAction] = useActionState(requestResetAction, initial);
  if (state.ok && state.message) {
    return <Banner tone="success" role="alert">{state.message}</Banner>;
  }
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <div>
        <label htmlFor="email" className="block text-meta font-medium text-ink mb-1.5">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={state.error ? 'true' : 'false'}
        />
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
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  );
}
