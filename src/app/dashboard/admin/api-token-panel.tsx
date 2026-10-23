'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { toast } from 'sonner';
import { createApiTokenAction, revokeApiTokenAction, type ApiTokenActionState } from './api-token-actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const initial: ApiTokenActionState = { ok: false };

export interface ApiTokenRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/**
 * Settings → API tokens tab body. Lists the org's tokens (scope badges,
 * created / last-used / expiry, revoke) and exposes a "Create token" dialog.
 * After a successful create, the plaintext token is shown EXACTLY ONCE in a
 * copy-friendly callout — admins must copy it now; only its SHA-256 is stored.
 */
export function ApiTokenPanel({ tokens }: { tokens: ApiTokenRow[] }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createApiTokenAction, initial);
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);

  useEffect(() => {
    if (state.ok && state.revealedToken) {
      setRevealed({ token: state.revealedToken, name: state.revealedName ?? '' });
      setOpen(false);
      toast.success('API token created.');
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[15px] font-semibold text-foreground">API tokens</h2>
        <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">
          Tokens authenticate the REST API at <code className="font-mono text-[12px]">/api/v1</code>.
          Send them as <code className="font-mono text-[12px]">Authorization: Bearer …</code>.
          The <code className="font-mono text-[12px]">read</code> scope lists and downloads envelopes;
          <code className="font-mono text-[12px]"> write</code> additionally creates and sends them.
          Only the token&apos;s hash is stored — the plaintext is shown once at creation.
        </p>
      </div>

      {revealed && (
        <div className="rounded-md border border-status-progress-border bg-status-progress-bg/40 p-4">
          <p className="text-[12.5px] font-semibold text-status-progress mb-2">
            Copy this token now — it won&apos;t be shown again
          </p>
          <div
            data-testid="api-token-reveal"
            className="rounded bg-card border border-border px-3 py-2 font-mono text-[12px] text-foreground break-all select-all"
          >
            {revealed.token}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(revealed.token).catch(() => undefined);
                toast.success('Token copied to clipboard.');
              }}
              className="inline-flex h-8 items-center px-3 rounded-md border border-border bg-card text-[12.5px] font-medium text-foreground hover:bg-muted/60"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => setRevealed(null)}
              className="inline-flex h-8 items-center px-3 rounded-md border border-border bg-card text-[12.5px] font-medium text-foreground hover:bg-muted/60"
            >
              I copied it
            </button>
          </div>
        </div>
      )}

      <div>
        <Button onClick={() => setOpen(true)}>Create token</Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Create API token</DialogTitle>
            <DialogDescription>
              Name it so you can tell integrations apart later. The plaintext
              token is shown once — store it somewhere safe.
            </DialogDescription>
          </DialogHeader>
          <form action={formAction} className="px-5 py-4 space-y-4">
            <label className="block">
              <span className="block text-[12px] font-medium text-muted-foreground mb-1">Name</span>
              <input
                type="text"
                name="name"
                required
                maxLength={100}
                placeholder="CI integration"
                className="w-full h-9 px-3 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
              />
            </label>
            <fieldset>
              <legend className="text-[12px] font-medium text-muted-foreground mb-2">Scopes</legend>
              <div className="flex gap-4">
                <label className="inline-flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" name="scopes" value="read" defaultChecked className="accent-primary" />
                  read
                </label>
                <label className="inline-flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" name="scopes" value="write" className="accent-primary" />
                  write
                </label>
              </div>
            </fieldset>
            <label className="block">
              <span className="block text-[12px] font-medium text-muted-foreground mb-1">
                Expires in days (optional)
              </span>
              <input
                type="number"
                name="expiresInDays"
                min={1}
                max={3650}
                placeholder="Never"
                className="w-full h-9 px-3 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
              />
            </label>
            {state.error && <p className="text-[12px] text-destructive">{state.error}</p>}
            <div className="flex justify-end">
              <CreateBtn />
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {tokens.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-6 py-10 text-center text-[13px] text-faint">
          No API tokens yet. Create one to integrate DocuRidge with your tooling.
        </div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg bg-card">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="block text-[13px] font-medium text-foreground truncate">
                  {t.name}
                  {t.revokedAt && (
                    <span className="ml-2 text-[11px] font-medium text-faint">revoked</span>
                  )}
                </p>
                <p className="block text-[11.5px] text-faint mt-0.5">
                  {t.scopes.join(' + ')}
                  {' · '}
                  Created {new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {' · '}
                  Last used {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'never'}
                  {' · '}
                  {t.expiresAt ? `Expires ${new Date(t.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Never expires'}
                </p>
              </div>
              {!t.revokedAt && (
                <form action={revokeApiTokenAction} className="contents">
                  <input type="hidden" name="id" value={t.id} />
                  <button
                    type="submit"
                    className="inline-flex h-8 items-center px-3 rounded-md text-[12.5px] font-medium text-faint hover:text-destructive"
                  >
                    Revoke
                  </button>
                </form>
              )}
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
      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Creating…' : 'Create token'}
    </button>
  );
}
