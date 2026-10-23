'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  updateBrandingAction,
  removeOrgLogoAction,
  type BrandingActionState,
  type AvatarActionState,
} from '../settings/actions';

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
      <p className="text-[13px] text-muted-foreground mb-5">
        Customize how recipients see emails from your organization. Org-wide settings — only admins can change them.
      </p>

      {/* Logo */}
      <div className="rounded-lg border border-border bg-card p-4 flex items-start gap-4 mb-4">
        <div className="h-16 w-16 rounded-md border border-border bg-muted/50 overflow-hidden flex items-center justify-center flex-shrink-0">
          {previewSrc ? (
            <img src={previewSrc} alt={`${orgName} logo`} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-[10px] font-mono uppercase tracking-[0.06em] text-faint text-center px-1">No logo</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-foreground">Email logo</p>
          <p className="text-[11.5px] text-faint leading-snug">
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
              className="inline-flex h-8 items-center px-3 rounded-md border border-border bg-card text-[12.5px] font-medium text-foreground hover:bg-muted/60"
            >
              Choose file…
            </button>
            {previewSrc && initialLogoSrc && (
              <button
                type="submit"
                form="brand-logo-remove"
                className="inline-flex h-8 items-center px-3 rounded-md text-[12.5px] font-medium text-faint hover:text-destructive"
              >
                Remove
              </button>
            )}
          </div>
          {removeFeedback && (
            <p className="mt-2 text-[11.5px] text-success">✓ {removeFeedback}</p>
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
        <span className="text-[12px] text-faint">
          {showSuccess && <span className="text-success">✓ {state.success}</span>}
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
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      {textarea ? (
        <textarea
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          rows={2}
          className="px-3 py-2 rounded-md bg-card border border-border text-[13.5px] text-foreground placeholder:text-faint outline-none focus:border-primary focus:ring-3 focus:ring-primary/12 resize-none"
        />
      ) : (
        <input
          type="text"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="h-9 px-3 rounded-md bg-card border border-border text-[13.5px] text-foreground placeholder:text-faint outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
        />
      )}
      {description && <span className="text-[11.5px] text-faint leading-snug">{description}</span>}
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
      <span className="text-[12px] font-medium text-muted-foreground">Default field font</span>
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
                active ? 'border-primary bg-accent/40 ring-1 ring-primary/20' : 'border-border bg-card hover:bg-muted/60'
              }`}
            >
              <span className="text-[11px] font-medium text-muted-foreground">{o.label}</span>
              <span className="text-[15px] text-foreground truncate" style={{ fontFamily: o.cssFamily }}>{o.sample}</span>
            </button>
          );
        })}
      </div>
      <span className="text-[11.5px] text-faint leading-snug">
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
      <span className="text-[12px] font-medium text-muted-foreground">Brand color</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={display}
          onChange={(e) => setHex(e.currentTarget.value.toUpperCase())}
          aria-label="Pick brand color"
          className="h-9 w-12 cursor-pointer rounded-md border border-border bg-card p-1"
        />
        <input
          type="text"
          name="brandColor"
          value={hex}
          onChange={(e) => setHex(e.currentTarget.value.toUpperCase())}
          placeholder="#2544FB"
          maxLength={7}
          spellCheck={false}
          className="h-9 px-3 rounded-md bg-card border border-border text-[13.5px] font-mono text-foreground placeholder:text-faint outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
        />
        <span
          className="inline-flex items-center px-3 h-9 rounded-md text-[12.5px] font-medium text-white"
          style={{ background: display }}
        >
          Preview button
        </span>
      </div>
      <span className="text-[11.5px] text-faint leading-snug">
        Used for the button color in outbound emails and the accent stripe in the signing-page header. Leave blank for the default cobalt (<code className="font-mono">#2544FB</code>).
      </span>
    </label>
  );
}
