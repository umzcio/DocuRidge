'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  updateProfileAction,
  uploadAvatarAction,
  removeAvatarAction,
  type ProfileActionState,
  type AvatarActionState,
} from './actions';

const initial: ProfileActionState = { ok: false };
const avatarInitial: AvatarActionState = { ok: false };

export function ProfileForm({
  initialFullName,
  initialEmail,
  initialJobTitle,
  initialPhone,
  initialAddress,
  initialCompany,
  initialAvatarSrc,
}: {
  initialFullName: string;
  initialEmail: string;
  initialJobTitle: string;
  initialPhone: string;
  initialAddress: string;
  initialCompany: string;
  initialAvatarSrc: string | null;
}) {
  const [state, formAction] = useActionState(updateProfileAction, initial);
  const [showSuccess, setShowSuccess] = useState(false);
  useEffect(() => {
    if (state.ok && state.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [state]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4 max-w-2xl">
      <div className="sm:col-span-2 mb-2">
        <AvatarBlock initialAvatarSrc={initialAvatarSrc} initialName={initialFullName} />
      </div>

      <form action={formAction} className="contents">
        <Field
          label="Full name"
          name="fullName"
          defaultValue={initialFullName}
          error={state.fieldErrors?.fullName}
          required
        />
        <Field
          label="Email"
          name="email"
          type="email"
          defaultValue={initialEmail}
          disabled
        />
        <Field
          label="Job title"
          name="jobTitle"
          defaultValue={initialJobTitle}
          placeholder="e.g. Research Administrator"
          error={state.fieldErrors?.jobTitle}
        />
        <Field
          label="Company"
          name="company"
          defaultValue={initialCompany}
          placeholder="e.g. Acme Corp"
          error={state.fieldErrors?.company}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          defaultValue={initialPhone}
          placeholder="e.g. (406) 555-0123"
          error={state.fieldErrors?.phone}
        />
        <AddressField
          defaultValue={initialAddress}
          error={state.fieldErrors?.address}
        />
        <div className="sm:col-span-2 flex items-center justify-between mt-2">
          <span className="text-[12px] text-ink-tertiary">
            {showSuccess && <span className="text-status-completed">✓ {state.success}</span>}
            {state.error && !state.fieldErrors && <span className="text-status-declined">{state.error}</span>}
          </span>
          <SaveBtn />
        </div>
      </form>
    </div>
  );
}

function AvatarBlock({ initialAvatarSrc, initialName }: { initialAvatarSrc: string | null; initialName: string }) {
  const [uploadState, uploadAction] = useActionState(uploadAvatarAction, avatarInitial);
  const [removeState, removeAction] = useActionState(removeAvatarAction, avatarInitial);
  const [previewSrc, setPreviewSrc] = useState<string | null>(initialAvatarSrc);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (uploadState.ok && uploadState.success) {
      setFeedback({ ok: true, text: uploadState.success });
    } else if (uploadState.error) {
      setFeedback({ ok: false, text: uploadState.error });
    }
  }, [uploadState]);
  useEffect(() => {
    if (removeState.ok && removeState.success) {
      setFeedback({ ok: true, text: removeState.success });
      setPreviewSrc(null);
    } else if (removeState.error) {
      setFeedback({ ok: false, text: removeState.error });
    }
  }, [removeState]);
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    // Local preview so the user sees the new face before the action returns.
    const reader = new FileReader();
    reader.onload = () => setPreviewSrc(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(f);
    formRef.current?.requestSubmit();
  }

  return (
    <div className="flex items-start gap-4">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-canvas text-white text-[16px] font-semibold tracking-[0.02em] overflow-hidden">
        {previewSrc ? (
          <img src={previewSrc} alt="" className="h-full w-full object-cover" />
        ) : (
          initials(initialName)
        )}
      </span>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <form ref={formRef} action={uploadAction} className="contents">
            <input
              ref={inputRef}
              type="file"
              name="avatar"
              accept="image/png,image/jpeg,image/webp"
              onChange={onFileChosen}
              className="sr-only"
              aria-label="Choose avatar image"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex h-8 items-center px-3 rounded-md border border-hairline bg-surface text-[12.5px] font-medium text-ink hover:bg-surface-muted/60"
            >
              Change photo
            </button>
          </form>
          {previewSrc && (
            <form action={removeAction} className="contents">
              <button
                type="submit"
                className="inline-flex h-8 items-center px-3 rounded-md text-[12.5px] font-medium text-ink-tertiary hover:text-status-declined"
              >
                Remove
              </button>
            </form>
          )}
        </div>
        <p className="text-[11.5px] text-ink-tertiary">PNG, JPEG, or WebP — up to 200 KB.</p>
        {feedback && (
          <p className={`text-[11.5px] ${feedback.ok ? 'text-status-completed' : 'text-status-declined'}`}>
            {feedback.ok ? '✓ ' : ''}{feedback.text}
          </p>
        )}
      </div>
    </div>
  );
}

function SaveBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center px-4 rounded-md bg-accent text-white text-[13px] font-medium border border-accent-deep hover:bg-accent-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  );
}

function Field({
  label, name, type = 'text', defaultValue, placeholder, disabled, required, error,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-ink-secondary">{label}</span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-invalid={error ? 'true' : 'false'}
        className="h-9 px-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 disabled:bg-surface-muted/60 disabled:text-ink-secondary"
      />
      {error && <span className="text-[12px] text-status-declined">{error}</span>}
    </label>
  );
}

function AddressField({
  defaultValue, error,
}: { defaultValue?: string; error?: string }) {
  return (
    <label className="flex flex-col gap-1 sm:col-span-2">
      <span className="text-[12px] font-medium text-ink-secondary">Address</span>
      <textarea
        name="address"
        defaultValue={defaultValue}
        rows={3}
        placeholder="Street&#10;City, State ZIP"
        aria-invalid={error ? 'true' : 'false'}
        className="px-3 py-2 rounded-md bg-surface border border-hairline text-[13.5px] text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
      />
      {error && <span className="text-[12px] text-status-declined">{error}</span>}
    </label>
  );
}

function initials(name: string) {
  return (name.trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('') || '?').toUpperCase();
}
