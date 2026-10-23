'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner } from '@/components/ui/banner';
import { confirmEmailAction, type VerifyEmailState } from './actions';

const initial: VerifyEmailState = { ok: false };

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(confirmEmailAction, initial);
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="password" className="block text-meta font-medium text-foreground mb-1.5">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={state.fieldErrors?.password ? 'true' : 'false'}
          aria-describedby={state.fieldErrors?.password ? 'password-error' : undefined}
        />
        {state.fieldErrors?.password && (
          <p id="password-error" className="mt-1.5 text-meta text-destructive">
            {state.fieldErrors.password}
          </p>
        )}
      </div>
      {state.error && <Banner tone="error" role="alert">{state.error}</Banner>}
      <Submit />
      <p className="text-meta text-muted-foreground">
        Didn&apos;t create this account, or forgotten the password?{' '}
        <Link href="/reset" className="text-primary underline underline-offset-2 decoration-1 hover:decoration-2">
          Reset it
        </Link>
      </p>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="lg" className="w-full">
      {pending ? 'Verifying…' : 'Verify email'}
    </Button>
  );
}
