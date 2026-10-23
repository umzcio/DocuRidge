'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { submitPublicFormAction, type PublicFormSubmitState } from './actions';

const initial: PublicFormSubmitState = { ok: false };

export function PublicFormClient({ token, brandColor }: { token: string; brandColor: string | null }) {
  const [state, action] = useActionState(submitPublicFormAction, initial);
  const accent = brandColor && /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : undefined;
  return (
    <form action={action} className="mt-5 space-y-3">
      <input type="hidden" name="token" value={token} />
      <label className="block">
        <span className="block text-[12px] font-medium text-muted-foreground mb-1">Your name</span>
        <input
          type="text"
          name="name"
          required
          maxLength={120}
          autoFocus
          autoComplete="name"
          className="w-full h-9 px-3 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
        />
      </label>
      <label className="block">
        <span className="block text-[12px] font-medium text-muted-foreground mb-1">Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          className="w-full h-9 px-3 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
        />
      </label>
      {state.error && <p className="text-[12.5px] text-destructive">{state.error}</p>}
      <SubmitBtn brandColor={accent} />
    </form>
  );
}

function SubmitBtn({ brandColor }: { brandColor?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={brandColor ? { backgroundColor: brandColor, borderColor: brandColor } : undefined}
      className="w-full inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-primary px-5 text-[13.5px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-60"
    >
      {pending ? 'Starting…' : 'Start signing →'}
    </button>
  );
}
