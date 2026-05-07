'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  updateBrandingAction,
  removeOrgLogoAction,
  type BrandingActionState,
  type AvatarActionState,
} from './actions';

const initial: BrandingActionState = { ok: false };
const removeInitial: AvatarActionState = { ok: false };

export function BrandingForm({
  initialFromName,
  initialEmailFooter,
  initialBrandColor,
  initialFieldFont,
  initialLogoSrc,
  orgName,
}: {
  initialFromName: string;
  initialEmailFooter: string;
  initialBrandColor: string;
  initialFieldFont: string;
  initialLogoSrc: string | null;
  orgName: string;
}) {
  const [state, formAction] = useActionState(updateBrandingAction, initial);
  const [removeState, removeAction] = useActionState(removeOrgLogoAction, removeInitial);
  const [previewSrc, setPreviewSrc] = useState<string | null>(initialLogoSrc);
  const [showSuccess, setShowSuccess] = useState(false);
  const [removeFeedback, setRemoveFeedback] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.ok && state.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [state]);

  useEffect(() => {
    if (removeState.ok) {
      setPreviewSrc(null);
      setRemoveFeedback('Logo removed.');
      const t = setTimeout(() => setRemoveFeedback(null), 3000);
      return () => clearTimeout(t);
    }
  }, [removeState]);

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPreviewSrc(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(f);
  }

  return (
    <div className="max-w-2xl">
      {/* Logo-only remove form sits next to the upload form */}
      <form action={removeAction} id="brand-logo-remove" className="hidden" />
    <form action={formAction} encType="multipart/form-data">
      <p className="text-[13px] text-ink-secondary mb-5">
        Customize how recipients see emails from your organization. Org-wide settings — only admins can change them.
      </p>

      {/* Logo */}
      <div className="rounded-lg border border-hairline bg-surface p-4 flex items-start gap-4 mb-4">
        <div className="h-16 w-16 rounded-md border border-hairline bg-surface-muted/50 overflow-hidden flex items-center justify-center flex-shrink-0">
          {previewSrc ? (
            <img src={previewSrc} alt={`${orgName} logo`} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-tertiary text-center px-1">No logo</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-ink">Email logo</p>
          <p className="text-[11.5px] text-ink-tertiary leading-snug">
            Appears at the top of every notification recipients receive. PNG, JPEG, or WebP — up to 200 KB.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              name="logo"
              accept="image/png,image/jpeg,image/webp"
              onChange={onFileChosen}
              className="sr-only"
              aria-label="Choose logo image"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex h-8 items-center px-3 rounded-md border border-hairline bg-surface text-[12.5px] font-medium text-ink hover:bg-surface-muted/60"
            >
              Choose file…
            </button>
            {previewSrc && initialLogoSrc && (
              <button
                type="submit"
                form="brand-logo-remove"
                className="inline-flex h-8 items-center px-3 rounded-md text-[12.5px] font-medium text-ink-tertiary hover:text-status-declined"
              >
                Remove
              </button>
            )}
          </div>
          {removeFeedback && (
            <p className="mt-2 text-[11.5px] text-status-completed">✓ {removeFeedback}</p>
          )}
        </div>
      </div>

      <Field
        label="Sender display name"
        name="senderEmailFromName"
        defaultValue={initialFromName}
        placeholder={`e.g. ${orgName}`}
        description="Replaces the default sender name (the user's name) in outbound emails. Leave blank to use individual senders' names."
      />
      <Field
        label="Email footer"
        name="emailFooter"
        defaultValue={initialEmailFooter}
        textarea
        placeholder="e.g. Acme Corp · IT Operations · it@example.com"
        description="A short line appended to the bottom of every notification email. Plain text only."
      />

      <BrandColorField initialValue={initialBrandColor} />
      <FieldFontPicker initialValue={initialFieldFont} />

      <div className="flex items-center justify-between mt-4">
        <span className="text-[12px] text-ink-tertiary">
          {showSuccess && <span className="text-status-completed">✓ {state.success}</span>}
          {state.error && <span className="text-status-declined">{state.error}</span>}
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
      className="inline-flex h-9 items-center px-4 rounded-md bg-accent text-white text-[13px] font-medium border border-accent-deep hover:bg-accent-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save branding'}
    </button>
  );
}

function Field({
  label, name, defaultValue, placeholder, description, textarea,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  description?: string;
  textarea?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 mb-3">
      <span className="text-[12px] font-medium text-ink-secondary">{label}</span>
      {textarea ? (
        <textarea
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          rows={2}
          className="px-3 py-2 rounded-md bg-surface border border-hairline text-[13.5px] text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
        />
      ) : (
        <input
          type="text"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="h-9 px-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
        />
      )}
      {description && <span className="text-[11.5px] text-ink-tertiary leading-snug">{description}</span>}
    </label>
  );
}

/**
 * Color picker bound to the `brandColor` form field. Falls back to the
 * project default cobalt when empty. Accepts either the native
 * <input type="color"> picker or a hex string typed directly. Live preview
 * shows what the email button will look like with the chosen color.
 */
/**
 * Org-wide picker for the font used to render typed text fields (Date,
 * Text, Number, Name, Email, etc.) on sealed PDFs and the in-app
 * preview. Three native pdf-lib standard families: sans, serif, mono.
 */
function FieldFontPicker({ initialValue }: { initialValue: string }) {
  const [font, setFont] = useState(initialValue || 'sans');
  const options: { value: string; label: string; sample: string; cssFamily: string }[] = [
    { value: 'sans',  label: 'Sans-serif',  sample: 'Helvetica',   cssFamily: 'Inter, system-ui, sans-serif' },
    { value: 'serif', label: 'Serif',       sample: 'Times Roman', cssFamily: 'Georgia, "Times New Roman", serif' },
    { value: 'mono',  label: 'Monospace',   sample: 'Courier',     cssFamily: 'JetBrains Mono, ui-monospace, monospace' },
  ];
  return (
    <label className="flex flex-col gap-1 mb-3">
      <span className="text-[12px] font-medium text-ink-secondary">Default field font</span>
      <input type="hidden" name="defaultFieldFont" value={font} />
      <div className="grid grid-cols-3 gap-1.5">
        {options.map((o) => {
          const active = o.value === font;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setFont(o.value)}
              aria-pressed={active}
              className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded-md border text-left transition-colors ${
                active ? 'border-accent bg-accent-soft/40 ring-1 ring-accent/20' : 'border-hairline bg-surface hover:bg-surface-muted/60'
              }`}
            >
              <span className="text-[11px] font-medium text-ink-secondary">{o.label}</span>
              <span className="text-[15px] text-ink truncate" style={{ fontFamily: o.cssFamily }}>{o.sample}</span>
            </button>
          );
        })}
      </div>
      <span className="text-[11.5px] text-ink-tertiary leading-snug">
        Used to render typed text fields (Date, Text, Number, Name, Email, etc.) on sealed PDFs. Signatures and initials always use cursive — recipients pick the script style themselves.
      </span>
    </label>
  );
}

function BrandColorField({ initialValue }: { initialValue: string }) {
  const [hex, setHex] = useState(initialValue || '');
  const display = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#2544FB';
  return (
    <label className="flex flex-col gap-1 mb-3">
      <span className="text-[12px] font-medium text-ink-secondary">Brand color</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={display}
          onChange={(e) => setHex(e.currentTarget.value.toUpperCase())}
          aria-label="Pick brand color"
          className="h-9 w-12 cursor-pointer rounded-md border border-hairline bg-surface p-1"
        />
        <input
          type="text"
          name="brandColor"
          value={hex}
          onChange={(e) => setHex(e.currentTarget.value.toUpperCase())}
          placeholder="#2544FB"
          maxLength={7}
          spellCheck={false}
          className="h-9 px-3 rounded-md bg-surface border border-hairline text-[13.5px] font-mono text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
        />
        <span
          className="inline-flex items-center px-3 h-9 rounded-md text-[12.5px] font-medium text-white"
          style={{ background: display }}
        >
          Preview button
        </span>
      </div>
      <span className="text-[11.5px] text-ink-tertiary leading-snug">
        Used for the button color in outbound emails and the accent stripe in the signing-page header. Leave blank for the default cobalt (<code className="font-mono">#2544FB</code>).
      </span>
    </label>
  );
}
