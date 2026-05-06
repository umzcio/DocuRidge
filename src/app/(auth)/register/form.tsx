'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner } from '@/components/ui/banner';
import { registerAction, type RegisterActionState } from './actions';

const initialState: RegisterActionState = { ok: false };

export function RegisterForm() {
  const [state, formAction] = useActionState(registerAction, initialState);

  if (state.ok && state.message) {
    return (
      <Banner tone="success" role="alert">
        {state.message}
      </Banner>
    );
  }

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Field id="name" name="name" label="Full name" type="text"
        autoComplete="name" required error={state.fieldErrors?.name} />
      <Field id="email" name="email" label="Email" type="email"
        autoComplete="email" required error={state.fieldErrors?.email} />
      <Field id="password" name="password" label="Password" type="password"
        autoComplete="new-password" required error={state.fieldErrors?.password}
        hint="At least 12 characters." />
      <Field id="orgName" name="orgName" label="Organisation name" type="text"
        autoComplete="organization" required error={state.fieldErrors?.orgName} />
      {state.error && (
        <Banner tone="error" role="alert">{state.error}</Banner>
      )}
      <SubmitButton />
    </form>
  );
}

function Field(props: {
  id: string;
  name: string;
  label: string;
  type: string;
  autoComplete: string;
  required?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={props.id} className="block text-meta font-medium text-ink mb-1.5">
        {props.label}
      </label>
      <Input
        id={props.id}
        name={props.name}
        type={props.type}
        autoComplete={props.autoComplete}
        required={props.required}
        aria-invalid={props.error ? 'true' : 'false'}
        aria-describedby={
          props.error ? `${props.id}-error` : props.hint ? `${props.id}-hint` : undefined
        }
      />
      {props.hint && !props.error && (
        <p id={`${props.id}-hint`} className="mt-1.5 text-[12px] text-ink-tertiary">
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={`${props.id}-error`} className="mt-1.5 text-meta text-status-declined">
          {props.error}
        </p>
      )}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="lg" className="w-full">
      {pending ? 'Creating account…' : 'Create account'}
    </Button>
  );
}
