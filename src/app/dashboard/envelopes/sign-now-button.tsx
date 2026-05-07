'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signNowAction, type SignNowState } from './sign-now-actions';

const initial: SignNowState = { ok: false };

export function SignNowButton({
  envelopeId,
  size = 'md',
  variant = 'primary',
  label = 'Sign now',
}: {
  envelopeId: string;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
  label?: string;
}) {
  const [state, formAction] = useActionState(signNowAction, initial);
  return (
    <form action={formAction} className="inline-flex flex-col items-stretch">
      <input type="hidden" name="envelopeId" value={envelopeId} />
      <SubmitBtn size={size} variant={variant} label={label} />
      {state.error && (
        <p role="alert" className="mt-1 text-[11.5px] text-status-declined">{state.error}</p>
      )}
    </form>
  );
}

function SubmitBtn({ size, variant, label }: { size: 'sm' | 'md'; variant: 'primary' | 'secondary'; label: string }) {
  const { pending } = useFormStatus();
  const sizeClass = size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-9 px-3.5 text-[13px]';
  const variantClass = variant === 'primary'
    ? 'bg-accent text-white border-accent-deep hover:bg-accent-deep'
    : 'bg-surface text-ink border-hairline hover:bg-surface-muted/60';
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 ${sizeClass} ${variantClass}`}
    >
      <PenIcon /> {pending ? 'Opening…' : label}
    </button>
  );
}

function PenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M3 21h18" />
    </svg>
  );
}
