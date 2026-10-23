'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { saveSsoConfigAction, type SsoConfigActionState } from './sso-actions';

const initial: SsoConfigActionState = { ok: false };

export function SsoForm({
  initialEnabled,
  initialIssuer,
  initialClientId,
  hasSecret,
  initialScopes,
  orgName,
  callbackUrl,
}: {
  initialEnabled: boolean;
  initialIssuer: string;
  initialClientId: string;
  hasSecret: boolean;
  initialScopes: string;
  orgName: string;
  callbackUrl: string;
}) {
  const [state, formAction] = useActionState(saveSsoConfigAction, initial);
  const [enabled, setEnabled] = useState(initialEnabled);

  return (
    <div className="max-w-2xl">
      <form action={formAction}>
        <p className="text-[13px] text-muted-foreground mb-5">
          Let {orgName} staff sign in through your organization&apos;s identity provider
          (Microsoft Entra, Okta, …) instead of a password. Personal accounts are unaffected.
        </p>

        {/* Enable toggle — hidden input carries the value on submit. */}
        <input type="hidden" name="ssoEnabled" value={enabled ? 'on' : ''} />
        <div className="rounded-lg border border-border bg-card p-4 flex items-center justify-between gap-4 mb-4">
          <div>
            <p className="text-[13px] font-medium text-foreground">Enable single sign-on</p>
            <p className="text-[11.5px] text-faint leading-snug">
              Shows a &quot;Sign in with SSO&quot; button on the login page. All fields below are
              required before enabling.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable single sign-on"
            onClick={() => setEnabled((v) => !v)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              enabled ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                enabled ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>

        <div className={enabled ? '' : 'opacity-60 pointer-events-none'} aria-hidden={!enabled}>
          <Field
            label="Issuer URL"
            name="ssoIssuer"
            defaultValue={initialIssuer}
            placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0"
            error={state.fieldErrors?.ssoIssuer}
            description="Your IdP's OIDC issuer — endpoints are discovered from its /.well-known/openid-configuration. The deployment operator must first bind this exact issuer to your organisation."
          />
          <Field
            label="Client ID"
            name="ssoClientId"
            defaultValue={initialClientId}
            placeholder="Application (client) ID"
            error={state.fieldErrors?.ssoClientId}
          />
          <Field
            label="Client secret"
            name="ssoClientSecret"
            type="password"
            autoComplete="new-password"
            placeholder={hasSecret ? '•••••••• (saved — leave blank to keep)' : 'Client secret from your IdP'}
            error={state.fieldErrors?.ssoClientSecret}
          />
          <Field
            label="Scopes"
            name="ssoScopes"
            defaultValue={initialScopes}
            placeholder="openid profile email"
            description="Space-separated. 'openid profile email' is what the JIT provisioning needs (sub, email, name)."
          />
        </div>

        <div className="rounded-md border border-border bg-muted/40 p-3 mb-4">
          <p className="text-[11.5px] text-muted-foreground leading-snug">
            In your IdP (Entra: <span className="font-mono">App registrations → Authentication</span>),
            add this redirect URI:
            <code className="block mt-1 font-mono text-[11px] text-foreground break-all">{callbackUrl}</code>
          </p>
        </div>

        <div className="flex items-center justify-between mt-4">
          <span className="text-[12px] text-faint">
            {state.ok && state.success && <span className="text-success">✓ {state.success}</span>}
            {state.error && <span className="text-destructive">{state.error}</span>}
          </span>
          <SaveBtn />
        </div>
      </form>
    </div>
  );
}

function SaveBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-white text-[13px] font-medium border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save SSO settings'}
    </button>
  );
}

function Field({
  label, name, defaultValue, placeholder, description, type, autoComplete, error,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  description?: string;
  type?: string;
  autoComplete?: string;
  error?: string;
}) {
  return (
    <label className="flex flex-col gap-1 mb-3">
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      <input
        type={type ?? 'text'}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={error ? 'true' : 'false'}
        className="h-9 px-3 rounded-md bg-card border border-border text-[13.5px] text-foreground placeholder:text-faint outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
      />
      {error && <span className="text-[11.5px] text-destructive">{error}</span>}
      {description && !error && <span className="text-[11.5px] text-faint leading-snug">{description}</span>}
    </label>
  );
}
