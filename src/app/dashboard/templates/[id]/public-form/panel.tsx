'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { togglePublicFormAction, type PublicFormActionState } from './actions';

const initial: PublicFormActionState = { ok: false };

/**
 * Toggle PowerForms (public-link envelope creation) for a template. When
 * enabled, copy-to-clipboard surfaces the share URL. Disabling immediately
 * invalidates the prior URL.
 */
export function PublicFormPanel({
  templateId, enabled, publicUrl,
}: {
  templateId: string;
  enabled: boolean;
  publicUrl: string | null;
}) {
  const [state, action] = useActionState(togglePublicFormAction, initial);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div>
      <h2 className="text-base font-semibold mb-1">Public form (PowerForms)</h2>
      <p className="text-sm text-muted-foreground mb-3 leading-relaxed">
        Anyone with the link below can spin up a fresh envelope from this template by entering their name + email. They&apos;ll be redirected straight into the signing ceremony — no email round-trip.
      </p>
      {state.error && (
        <p className="mb-3 text-[12.5px] text-destructive">{state.error}</p>
      )}
      {enabled && publicUrl && (
        <div className="mb-3 rounded-md border border-success-border bg-success-bg/40 p-3">
          <p className="text-[11px] font-mono uppercase tracking-[0.06em] text-success mb-1">Share URL</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-card border border-border px-2 py-1 font-mono text-[11.5px] text-foreground select-all">
              {publicUrl}
            </code>
            <button
              type="button"
              onClick={async () => {
                try { await navigator.clipboard.writeText(publicUrl); setCopied(true); } catch { /* ignore */ }
              }}
              className="inline-flex h-8 items-center px-3 rounded-md border border-border bg-card text-[12.5px] font-medium text-foreground hover:bg-muted/60"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="templateId" value={templateId} />
        <input type="hidden" name="enable" value={enabled ? '0' : '1'} />
        <ToggleBtn enabled={enabled} />
        {enabled && (
          <span className="text-[11.5px] text-faint leading-snug">
            Disabling immediately invalidates the URL.
          </span>
        )}
      </form>
    </div>
  );
}

function ToggleBtn({ enabled }: { enabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        enabled
          ? 'inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-muted-foreground hover:text-destructive disabled:opacity-50'
          : 'inline-flex h-9 items-center px-4 rounded-md bg-primary text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep disabled:opacity-50'
      }
    >
      {pending ? 'Working…' : enabled ? 'Disable public form' : 'Enable public form'}
    </button>
  );
}
