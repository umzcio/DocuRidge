'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { instantiateTemplateAction, type InstantiateState } from './actions';

interface RoleSlot {
  id: string;
  roleLabel: string;
  signingOrder: number;
}

const initial: InstantiateState = { ok: false };

export function InstantiateForm({
  templateId,
  recipients,
}: {
  templateId: string;
  recipients: RoleSlot[];
}) {
  const [state, formAction] = useActionState(instantiateTemplateAction, initial);
  const [mappings, setMappings] = useState<Record<string, { name: string; email: string }>>(() => {
    const init: Record<string, { name: string; email: string }> = {};
    for (const r of recipients) init[r.id] = { name: '', email: '' };
    return init;
  });

  function update(id: string, patch: Partial<{ name: string; email: string }>) {
    setMappings((cur) => ({ ...cur, [id]: { ...cur[id]!, ...patch } }));
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="templateId" value={templateId} />
      <input type="hidden" name="roleMappings" value={JSON.stringify(mappings)} />
      <ul className="space-y-3">
        {recipients.map((r) => (
          <li key={r.id} className="rounded-md border border-neutral-200 p-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
              Role: <span className="font-semibold text-neutral-800">{r.roleLabel}</span> · signs {ordinal(r.signingOrder)}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="block font-medium text-neutral-700">Name</span>
                <input
                  required
                  value={mappings[r.id]!.name}
                  onChange={(e) => update(r.id, { name: e.currentTarget.value })}
                  className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="block font-medium text-neutral-700">Email</span>
                <input
                  required
                  type="email"
                  value={mappings[r.id]!.email}
                  onChange={(e) => update(r.id, { email: e.currentTarget.value })}
                  className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
          </li>
        ))}
      </ul>
      {state.error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
      )}
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:opacity-50"
    >
      {pending ? 'Sending…' : 'Create envelope from template'}
    </button>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
