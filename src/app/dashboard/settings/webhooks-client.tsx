'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  createWebhookAction,
  toggleWebhookAction,
  deleteWebhookAction,
  type WebhookActionState,
} from './webhook-actions';

const initial: WebhookActionState = { ok: false };

interface SubRow {
  id: string;
  url: string;
  enabled: boolean;
  eventCount: number;
  callCount: number;
  createdAt: string;
}

/**
 * Settings → Webhooks tab body. Lists existing subscriptions and exposes
 * an "Add webhook" form. After a successful create, the auto-generated
 * secret is shown EXACTLY ONCE in a copy-friendly callout — admins must
 * copy it before navigating away.
 */
export function WebhooksClient({ subs }: { subs: SubRow[] }) {
  const [state, action] = useActionState(createWebhookAction, initial);
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    if (state.ok && state.revealedSecret) setRevealed(state.revealedSecret);
  }, [state]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Outbound webhooks</h2>
        <p className="mt-1 text-[13px] text-ink-secondary leading-relaxed">
          DocuRidge POSTs every audit event to the URLs below. Each delivery is signed with HMAC-SHA256 over the JSON body
          using the subscription's secret — verify with <code className="font-mono text-[12px]">X-DocuRidge-Signature: sha256=&lt;hex&gt;</code>.
          Receivers should respond <code className="font-mono">200</code> within 5 seconds and be idempotent.
        </p>
      </div>

      {revealed && (
        <div className="rounded-md border border-status-progress-border bg-status-progress-bg/40 p-4">
          <p className="text-[12.5px] font-semibold text-status-progress mb-2">
            Copy this secret now — it won't be shown again
          </p>
          <div className="rounded bg-surface border border-hairline px-3 py-2 font-mono text-[12px] text-ink break-all select-all">
            {revealed}
          </div>
          <button
            type="button"
            onClick={() => setRevealed(null)}
            className="mt-3 inline-flex h-8 items-center px-3 rounded-md border border-hairline bg-surface text-[12.5px] font-medium text-ink hover:bg-surface-muted/60"
          >
            I copied it
          </button>
        </div>
      )}

      <form action={action} className="rounded-lg border border-hairline bg-surface-muted/30 p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3">
          <label className="block">
            <span className="block text-[12px] font-medium text-ink-secondary mb-1">URL</span>
            <input
              type="url"
              name="url"
              required
              placeholder="https://example.com/docuridge/webhook"
              className="w-full h-9 px-3 rounded-md border border-hairline bg-surface text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 font-mono"
            />
          </label>
          <label className="block">
            <span className="block text-[12px] font-medium text-ink-secondary mb-1">Description (optional)</span>
            <input
              type="text"
              name="description"
              maxLength={200}
              placeholder="Slack notifier, Audit log…"
              className="w-full h-9 px-3 rounded-md border border-hairline bg-surface text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
            />
          </label>
        </div>
        {state.error && <p className="text-[12px] text-status-declined">{state.error}</p>}
        <div className="flex justify-end">
          <CreateBtn />
        </div>
      </form>

      {subs.length === 0 ? (
        <div className="rounded-md border border-dashed border-hairline px-6 py-10 text-center text-[13px] text-ink-tertiary">
          No webhooks yet. Add one above to start receiving events.
        </div>
      ) : (
        <ul className="divide-y divide-hairline border border-hairline rounded-lg bg-surface">
          {subs.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={`inline-flex h-2 w-2 rounded-full flex-shrink-0 ${s.enabled ? 'bg-status-completed' : 'bg-ink-tertiary'}`}
                aria-label={s.enabled ? 'Active' : 'Paused'}
              />
              <div className="flex-1 min-w-0">
                <p className="block text-[13px] font-mono text-ink truncate">{s.url}</p>
                <p className="block text-[11.5px] text-ink-tertiary mt-0.5">
                  {s.eventCount === 0 ? 'All events' : `${s.eventCount} events`}
                  {' · '}
                  {s.callCount} {s.callCount === 1 ? 'delivery' : 'deliveries'}
                  {' · '}
                  Created {new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              <form action={toggleWebhookAction} className="contents">
                <input type="hidden" name="id" value={s.id} />
                <button
                  type="submit"
                  className="inline-flex h-8 items-center px-3 rounded-md border border-hairline bg-surface text-[12.5px] font-medium text-ink-secondary hover:text-ink hover:bg-surface-muted/60"
                >
                  {s.enabled ? 'Pause' : 'Resume'}
                </button>
              </form>
              <form action={deleteWebhookAction} className="contents">
                <input type="hidden" name="id" value={s.id} />
                <button
                  type="submit"
                  className="inline-flex h-8 items-center px-3 rounded-md text-[12.5px] font-medium text-ink-tertiary hover:text-status-declined"
                >
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-[13px] font-medium text-white border border-accent-deep hover:bg-accent-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Creating…' : 'Add webhook'}
    </button>
  );
}
