'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { registerAction, type RegisterActionState } from './actions';

const initialState: RegisterActionState = { ok: false };

export function RegisterForm() {
  const [state, formAction] = useActionState(registerAction, initialState);

  if (state.ok && state.message) {
    return (
      <div role="alert" className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800">
        {state.message}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Field
        id="name" name="name" label="Full name" type="text"
        autoComplete="name" required error={state.fieldErrors?.name}
      />
      <Field
        id="email" name="email" label="Email" type="email"
        autoComplete="email" required error={state.fieldErrors?.email}
      />
      <Field
        id="password" name="password" label="Password" type="password"
        autoComplete="new-password" required error={state.fieldErrors?.password}
        hint="At least 12 characters."
      />
      <Field
        id="orgName" name="orgName" label="Organisation name" type="text"
        autoComplete="organization" required error={state.fieldErrors?.orgName}
      />
      {state.error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
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
      <label htmlFor={props.id} className="block text-sm font-medium text-neutral-700">
        {props.label}
      </label>
      <input
        id={props.id}
        name={props.name}
        type={props.type}
        autoComplete={props.autoComplete}
        required={props.required}
        className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm"
        aria-invalid={props.error ? 'true' : 'false'}
        aria-describedby={
          props.error ? `${props.id}-error` : props.hint ? `${props.id}-hint` : undefined
        }
      />
      {props.hint && !props.error && (
        <p id={`${props.id}-hint`} className="mt-1 text-xs text-neutral-500">
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={`${props.id}-error`} className="mt-1 text-sm text-red-700">
          {props.error}
        </p>
      )}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:opacity-50"
    >
      {pending ? 'Creating account…' : 'Create account'}
    </button>
  );
}
