'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { updateNotificationsAction, type NotificationsActionState } from './actions';

const initial: NotificationsActionState = { ok: false };

export interface NotificationPrefs {
  sentForSignature: boolean;
  recipientSigned: boolean;
  completed: boolean;
  declined: boolean;
  reminderDigest: boolean;
}

export function NotificationsForm({ prefs }: { prefs: NotificationPrefs }) {
  const [state, formAction] = useActionState(updateNotificationsAction, initial);
  const [showSuccess, setShowSuccess] = useState(false);
  useEffect(() => {
    if (state.ok && state.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [state]);

  return (
    <form action={formAction} className="max-w-2xl">
      <p className="text-[13px] text-ink-secondary mb-4">
        Choose when DocuRidge emails you about your documents.
      </p>
      <ul className="divide-y divide-hairline border border-hairline rounded-lg bg-surface">
        <NotifRow
          name="sentForSignature"
          label="Sent for signature"
          description="When you send a document and the first recipient is notified."
          defaultChecked={prefs.sentForSignature}
        />
        <NotifRow
          name="recipientSigned"
          label="Recipient signed"
          description="Each time a recipient completes their part."
          defaultChecked={prefs.recipientSigned}
        />
        <NotifRow
          name="completed"
          label="Document completed"
          description="When the last recipient signs and the sealed copy is ready."
          defaultChecked={prefs.completed}
        />
        <NotifRow
          name="declined"
          label="Document declined"
          description="When a recipient declines to sign."
          defaultChecked={prefs.declined}
        />
        <NotifRow
          name="reminderDigest"
          label="Daily reminder digest"
          description="A single morning summary of pending documents instead of per-event mail."
          defaultChecked={prefs.reminderDigest}
        />
      </ul>

      <div className="flex items-center justify-between mt-5">
        <span className="text-[12px] text-ink-tertiary">
          {showSuccess && <span className="text-status-completed">✓ {state.success}</span>}
          {state.error && <span className="text-status-declined">{state.error}</span>}
        </span>
        <SaveBtn />
      </div>
    </form>
  );
}

function NotifRow({ name, label, description, defaultChecked }: { name: string; label: string; description: string; defaultChecked: boolean }) {
  return (
    <li className="flex items-start gap-4 px-4 py-3.5">
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        <span className="block text-[12px] text-ink-tertiary leading-snug">{description}</span>
      </span>
      <ToggleSwitch name={name} defaultChecked={defaultChecked} />
    </li>
  );
}

function ToggleSwitch({ name, defaultChecked }: { name: string; defaultChecked: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <label className="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => setChecked(e.currentTarget.checked)}
        className="peer sr-only"
      />
      <span className={`absolute inset-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-muted'}`} />
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </label>
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
      {pending ? 'Saving…' : 'Save preferences'}
    </button>
  );
}
