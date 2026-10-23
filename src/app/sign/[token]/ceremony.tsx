'use client';

import { useActionState, useRef, useState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import {
  consentAction,
  submitSigningAction,
  declineAction,
  uploadAttachmentAction,
  reassignAction,
  addCommentRecipientAction,
  verifyRecipientAccessCodeAction,
  type SignActionState,
  type CommentActionState,
} from './actions';
import { DocumentView } from './document-view';
import { evaluateFormula as evalFormula, formatFormulaValue as formatFormula } from '@/lib/formula/eval';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SIGNATURE_FONTS, DEFAULT_SIGNATURE_FONT, fontByKey, type SignatureFontKey } from '@/lib/signature-fonts';

interface FieldDef {
  id: string;
  type: string;
  page: number;
  required: boolean;
  defaultValue?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  readOnly?: boolean;
  charLimit?: number;
  pattern?: string;
  patternMessage?: string;
  min?: number;
  max?: number;
  options?: string[];
  formula?: string;
  noteText?: string;
  stampImageBase64?: string;
  stampMimeType?: string;
  condition?: { whenFieldId: string; equals: string };
  /** ATTACHMENT only: existing uploaded file (null if not yet uploaded). */
  attachment?: { filename: string; sizeBytes: number; sha256: string } | null;
}

const initial: SignActionState = { ok: false };

interface Props {
  token: string;
  envelopeTitle: string;
  senderName: string;
  senderEmail: string;
  message?: string | null;
  recipient: {
    id: string;
    name: string;
    email: string;
    role?: string;
    jobTitle?: string | null;
    phone?: string | null;
    address?: string | null;
    company?: string | null;
  };
  fields: FieldDef[];
  consentAlreadyGiven: boolean;
  /**
   * Access-code gate: `accessCodeRequired` means the sender configured a code
   * for this recipient; `accessCodeUnlocked` means the server found a valid
   * signed unlock cookie on the signing page. The gate renders between
   * consent and signing whenever a code is required but not yet unlocked.
   */
  accessCodeRequired: boolean;
  accessCodeUnlocked: boolean;
  isSignedIn: boolean;
  /** Pre-loaded saved signature (drawn or typed) from the recipient's User row, if any. */
  defaultSignature?: { pngBase64: string | null; typed: string | null } | null;
  defaultInitials?: { pngBase64: string | null; typed: string | null } | null;
  /** Server-loaded comment thread, oldest first. Both sides write to it. */
  comments?: Array<{
    id: string;
    authorName: string;
    isSender: boolean;
    isOwnPost: boolean;
    body: string;
    createdAt: string;
  }>;
}

const FIELD_LABEL: Record<string, string> = {
  SIGNATURE: 'Signature',
  INITIALS: 'Initials',
  DATE: 'Date',
  TEXT: 'Text',
  NUMBER: 'Number',
  CHECKBOX: 'Confirmation',
  NAME: 'Name',
  EMAIL: 'Email',
  JOB_TITLE: 'Job title',
  PHONE: 'Phone',
  ADDRESS: 'Address',
  COMPANY: 'Company',
  DROPDOWN: 'Choose one',
  RADIO: 'Choose one',
  FORMULA: 'Calculated',
  ATTACHMENT: 'Upload file',
  APPROVE: 'Approve',
  DECLINE: 'Decline',
  NOTE: 'Note',
  LINE: 'Line',
  STAMP: 'Stamp',
};

export function SigningCeremony(props: Props) {
  // Phase order: consent → unlock (only when an access code is configured
  // and not yet unlocked) → sign → done/declined/reassigned.
  const needsUnlock = props.accessCodeRequired && !props.accessCodeUnlocked;
  const [phase, setPhase] = useState<'consent' | 'unlock' | 'sign' | 'done' | 'declined' | 'reassigned'>(
    props.consentAlreadyGiven ? (needsUnlock ? 'unlock' : 'sign') : 'consent',
  );
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [showDecline, setShowDecline] = useState(false);
  const [showReassign, setShowReassign] = useState(false);

  if (phase === 'done') {
    return <SuccessScreen
      title="Document signed"
      sub={doneMsg ?? "Your signature has been recorded. The sender will be notified and you'll receive a copy by email."}
      isSignedIn={props.isSignedIn}
    />;
  }
  if (phase === 'declined') {
    return <SuccessScreen
      tone="declined"
      title="Document declined"
      sub={doneMsg ?? 'The sender has been notified.'}
      isSignedIn={props.isSignedIn}
    />;
  }
  if (phase === 'reassigned') {
    return <SuccessScreen
      title="Forwarded successfully"
      sub={doneMsg ?? 'The new recipient has been emailed. You can close this page.'}
      isSignedIn={props.isSignedIn}
    />;
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <header className="bg-card border-b border-border px-6 lg:px-8 h-14 flex items-center gap-4">
        <p className="text-[15px] font-semibold tracking-[-0.012em] text-foreground truncate">
          {props.envelopeTitle}
        </p>
        <span className="hidden sm:inline-flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-[0.06em] text-faint border border-border rounded-full px-2 py-0.5">
          <ShieldIcon /> Sealed audit · ed25519
        </span>
        <span className="ml-auto text-[12px] text-faint">
          From <span className="text-foreground font-medium">{props.senderName}</span>
        </span>
      </header>

      {phase === 'consent' && (
        <ConsentStage
          token={props.token}
          onDone={() => setPhase(props.accessCodeRequired && !props.accessCodeUnlocked ? 'unlock' : 'sign')}
        />
      )}
      {phase === 'unlock' && <UnlockStage token={props.token} onDone={() => setPhase('sign')} />}
      {phase === 'sign' && (
        <SignStage
          token={props.token}
          envelopeTitle={props.envelopeTitle}
          senderName={props.senderName}
          senderEmail={props.senderEmail}
          message={props.message}
          recipient={props.recipient}
          fields={props.fields}
          defaultSignature={props.defaultSignature ?? null}
          defaultInitials={props.defaultInitials ?? null}
          isSignedIn={props.isSignedIn}
          comments={props.comments ?? []}
          onDone={(msg) => { setDoneMsg(msg); setPhase('done'); }}
          onDeclineClick={() => setShowDecline(true)}
          onReassignClick={() => setShowReassign(true)}
        />
      )}

      <Dialog open={showDecline} onOpenChange={setShowDecline}>
        <DeclineDialog
          token={props.token}
          onCancel={() => setShowDecline(false)}
          onDeclined={(msg) => {
            // Drop the saved draft — declined envelopes never resume.
            try { window.localStorage.removeItem(`docuridge:signing-draft:${props.token}`); } catch { /* ignore */ }
            setDoneMsg(msg); setPhase('declined'); setShowDecline(false);
          }}
        />
      </Dialog>
      <Dialog open={showReassign} onOpenChange={setShowReassign}>
        <ReassignDialog
          token={props.token}
          currentEmail={props.recipient.email}
          onCancel={() => setShowReassign(false)}
          onReassigned={(msg) => {
            // Drop the saved draft — the new recipient won't resume our progress.
            try { window.localStorage.removeItem(`docuridge:signing-draft:${props.token}`); } catch { /* ignore */ }
            setDoneMsg(msg); setPhase('reassigned'); setShowReassign(false);
          }}
        />
      </Dialog>
    </div>
  );
}

/* ─── Consent stage ─────────────────────────────────────────────── */
function ConsentStage({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, formAction] = useActionState(consentAction, initial);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { if (state.ok) onDone(); }, [state.ok, onDone]);

  return (
    <main className="flex-1 flex items-center justify-center px-6 py-10">
      <form action={formAction} className="w-full max-w-xl rounded-lg border border-border bg-card p-6 sm:p-8">
        <input type="hidden" name="token" value={token} />
        <span className="inline-flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-[0.08em] text-primary">
          <ShieldIcon /> Before you sign
        </span>
        <h1 className="mt-2 text-[22px] sm:text-[26px] font-semibold tracking-[-0.022em] text-foreground">
          Electronic signature consent
        </h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          By using DocuRidge to sign this document, you agree that your electronic signature is legally binding under the Uniform Electronic Transactions Act (UETA) and the federal ESIGN Act.
        </p>
        <ul className="mt-4 space-y-2.5 text-[13px] text-muted-foreground">
          <ConsentItem>You may receive paper copies on request — contact the sender.</ConsentItem>
          <ConsentItem>You may withdraw consent for future documents at any time, ending electronic delivery for those documents.</ConsentItem>
          <ConsentItem>You have the hardware and software to receive electronic records (a modern web browser is sufficient).</ConsentItem>
          <ConsentItem>Each action is recorded in a tamper-evident, signed audit chain.</ConsentItem>
        </ul>
        <label className="mt-5 flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.currentTarget.checked)}
            className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-primary"
          />
          <span className="text-[13px] text-foreground">I agree to use electronic records and signatures for this document.</span>
        </label>
        {state.error && (
          <div role="alert" className="mt-4 rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-[12.5px] text-destructive">
            {state.error}
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <ConsentSubmit disabled={!accepted} />
        </div>
      </form>
    </main>
  );
}

function ConsentItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1.5 inline-flex h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
      <span>{children}</span>
    </li>
  );
}

function ConsentSubmit({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-5 text-[13.5px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {pending ? 'Recording…' : (<>I agree, continue <ChevronRight /></>)}
    </button>
  );
}

/* ─── Access-code unlock stage ─────────────────────────────────── */
function UnlockStage({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, formAction] = useActionState(verifyRecipientAccessCodeAction, { ok: false });
  useEffect(() => { if (state.ok) onDone(); }, [state.ok, onDone]);

  return (
    <main className="flex-1 flex items-center justify-center px-6 py-10">
      <form action={formAction} className="w-full max-w-xl rounded-lg border border-border bg-card p-6 sm:p-8">
        <input type="hidden" name="token" value={token} />
        <span className="inline-flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-[0.08em] text-primary">
          <LockIcon /> Access code required
        </span>
        <h1 className="mt-2 text-[22px] sm:text-[26px] font-semibold tracking-[-0.022em] text-foreground">
          Enter your access code
        </h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          The sender protected this document with an access code. Enter the code they shared with you to continue.
        </p>
        <input
          name="code"
          autoFocus
          autoComplete="off"
          placeholder="e.g. K7P2QX"
          className="mt-5 block w-full h-11 px-3.5 rounded-md border border-input bg-card text-[15px] font-mono tracking-[0.12em] text-foreground placeholder:text-faint outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
          aria-invalid={!!state.error}
        />
        {state.error && (
          <div role="alert" className="mt-4 rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-[12.5px] text-destructive">
            {state.error}
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <UnlockSubmit />
        </div>
      </form>
    </main>
  );
}

function UnlockSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-5 text-[13.5px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {pending ? 'Checking…' : (<>Unlock document <ChevronRight /></>)}
    </button>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/* ─── Sign stage ───────────────────────────────────────────────── */
function SignStage(props: {
  token: string;
  envelopeTitle: string;
  senderName: string;
  senderEmail: string;
  message?: string | null;
  recipient: {
    id: string;
    name: string;
    email: string;
    role?: string;
    jobTitle?: string | null;
    phone?: string | null;
    address?: string | null;
    company?: string | null;
  };
  fields: FieldDef[];
  onDone: (msg: string) => void;
  defaultSignature: { pngBase64: string | null; typed: string | null } | null;
  defaultInitials: { pngBase64: string | null; typed: string | null } | null;
  isSignedIn: boolean;
  comments: Array<{ id: string; authorName: string; isSender: boolean; isOwnPost: boolean; body: string; createdAt: string }>;
  onDeclineClick: () => void;
  onReassignClick: () => void;
}) {
  // Field values
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of props.fields) {
      if (f.defaultValue) init[f.id] = f.defaultValue;
      if (f.type === 'NAME') init[f.id] = props.recipient.name;
      if (f.type === 'EMAIL') init[f.id] = props.recipient.email;
      if (f.type === 'JOB_TITLE' && props.recipient.jobTitle) init[f.id] = props.recipient.jobTitle;
      if (f.type === 'PHONE' && props.recipient.phone) init[f.id] = props.recipient.phone;
      if (f.type === 'ADDRESS' && props.recipient.address) init[f.id] = props.recipient.address;
      if (f.type === 'COMPANY' && props.recipient.company) init[f.id] = props.recipient.company;
    }
    return init;
  });
  // Signature and initials are independent marks — the user is asked to draw
  // them separately because they LOOK different (full signature vs initials).
  // Tracking them as distinct slots keeps each adoption isolated.
  // Pre-load saved defaults from the recipient's User row (if any). Drawn
  // signatures take precedence over typed when both are saved.
  const [signaturePng, setSignaturePng] = useState<string | null>(props.defaultSignature?.pngBase64 ?? null);
  const [typedSignature, setTypedSignature] = useState(
    props.defaultSignature?.pngBase64 ? '' : (props.defaultSignature?.typed ?? ''),
  );
  const [initialsPng, setInitialsPng] = useState<string | null>(props.defaultInitials?.pngBase64 ?? null);
  const [typedInitials, setTypedInitials] = useState(
    props.defaultInitials?.pngBase64 ? '' : (props.defaultInitials?.typed ?? ''),
  );
  // Cursive font keys chosen on the Type tab — sent through the action so
  // they get persisted alongside the typed text on the Signature row.
  const [signatureFont, setSignatureFont] = useState<SignatureFontKey | null>(null);
  const [initialsFont, setInitialsFont] = useState<SignatureFontKey | null>(null);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  // Remember the field that opened the modal so it stays resolved (for the
  // exit animation) while Radix keeps the content mounted after dismissal.
  const lastActiveFieldIdRef = useRef<string | null>(null);
  useEffect(() => { if (activeFieldId) lastActiveFieldIdRef.current = activeFieldId; }, [activeFieldId]);
  // Recipient-uploaded attachments keyed by ATTACHMENT field id. Seeded from
  // any prior upload (re-opening the link after refresh) and updated when
  // the upload action returns.
  const [attachments, setAttachments] = useState<Record<string, { filename: string; sizeBytes: number; sha256: string }>>(
    () => {
      const init: Record<string, { filename: string; sizeBytes: number; sha256: string }> = {};
      for (const f of props.fields) {
        if (f.type === 'ATTACHMENT' && f.attachment) init[f.id] = f.attachment;
      }
      return init;
    },
  );
  const [uploadingFieldId, setUploadingFieldId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, formAction] = useActionState(submitSigningAction, initial);
  const [draftSavedToast, setDraftSavedToast] = useState(false);

  /**
   * Finish-later: persist in-progress field values + adopted signature /
   * initials to localStorage on every state change, keyed by the signing
   * token. Same recipient on the same browser can close the tab and pick
   * back up where they left off. Cleared on submit / decline / reassign.
   */
  const draftKey = `docuridge:signing-draft:${props.token}`;
  // Hydrate saved draft on mount (one-shot effect — never rerun).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw) as {
        values?: Record<string, string>;
        signaturePng?: string | null; typedSignature?: string;
        initialsPng?: string | null; typedInitials?: string;
      };
      if (draft.values && Object.keys(draft.values).length) {
        setValues((cur) => ({ ...cur, ...draft.values }));
      }
      if (draft.signaturePng) setSignaturePng(draft.signaturePng);
      if (draft.typedSignature) setTypedSignature(draft.typedSignature);
      if (draft.initialsPng) setInitialsPng(draft.initialsPng);
      if (draft.typedInitials) setTypedInitials(draft.typedInitials);
    } catch {
      // Ignore malformed drafts — better to start fresh than crash the page.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist on any change to the tracked slots.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const draft = { values, signaturePng, typedSignature, initialsPng, typedInitials };
    try {
      window.localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // Quota exceeded or private mode — silent failure is acceptable.
    }
  }, [draftKey, values, signaturePng, typedSignature, initialsPng, typedInitials]);

  useEffect(() => {
    if (state.ok) {
      // Successful submit — clear the draft so it doesn't restore stale
      // values if the recipient lands here again post-completion.
      try { window.localStorage.removeItem(draftKey); } catch { /* ignore */ }
      props.onDone(state.message ?? 'Signed.');
    }
  }, [state.ok, state.message, props, draftKey]);

  // FORMULA fields are auto-computed from `values` of other fields. Their
  // computed value flows into the same `values`-shaped lookup so the
  // checklist, document overlay, and required-check can all treat them
  // identically to any other text-y field. Chains of formulas (one
  // referencing another) settle after a few passes — bound the loop.
  const formulaValues = (() => {
    const computed: Record<string, string> = {};
    const allRefs: Record<string, string> = { ...values };
    for (let pass = 0; pass < 5; pass++) {
      let changed = false;
      for (const f of props.fields) {
        if (f.type !== 'FORMULA' || !f.formula) continue;
        const r = evalFormula(f.formula, allRefs);
        const next = r.ok ? formatFormula(r.value) : '';
        if (computed[f.id] !== next) {
          computed[f.id] = next;
          allRefs[f.id] = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return computed;
  })();
  function fieldValue(f: FieldDef): string {
    if (f.type === 'FORMULA') return formulaValues[f.id] ?? '';
    return values[f.id] ?? '';
  }
  // What counts as completed?
  function isFieldComplete(f: FieldDef): boolean {
    if (f.type === 'SIGNATURE') return !!signaturePng || !!typedSignature.trim();
    if (f.type === 'INITIALS') return !!initialsPng || !!typedInitials.trim();
    if (f.type === 'CHECKBOX') return values[f.id] === 'true';
    if (f.type === 'NAME' || f.type === 'EMAIL') return !!values[f.id];
    if (f.type === 'DATE') return !!values[f.id];
    if (f.type === 'FORMULA') return !!formulaValues[f.id];
    if (f.type === 'ATTACHMENT') return !!attachments[f.id];
    if (f.type === 'DRAWING') return !!values[f.id];
    // NOTE / LINE / STAMP are display-only — never block completion.
    if (f.type === 'NOTE' || f.type === 'LINE' || f.type === 'STAMP') return true;
    // DECLINE is a shortcut into the global decline flow — never gates submit.
    if (f.type === 'DECLINE') return true;
    if (f.type === 'APPROVE') return !!values[f.id];
    return !!values[f.id];
  }
  /**
   * Conditional visibility — a field is visible iff it has no condition or
   * the controlling field's current value equals the trigger. Hidden fields
   * are excluded from completeness math, the checklist, and document
   * overlays. The server applies the same rule when validating submission.
   */
  function isFieldVisible(f: FieldDef): boolean {
    if (!f.condition) return true;
    const sourceValue = values[f.condition.whenFieldId] ?? '';
    return sourceValue === f.condition.equals;
  }
  const visibleFields = props.fields.filter(isFieldVisible);
  const total = visibleFields.length;
  const done = visibleFields.filter(isFieldComplete).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const requiredMissing = visibleFields.some((f) => f.required && !isFieldComplete(f));

  function activate(fieldId: string) {
    const f = props.fields.find((x) => x.id === fieldId);
    if (!f) return;
    // Read-only fields are sender-locked; recipient can't change the value.
    if (f.readOnly) return;
    if (f.type === 'DATE') {
      setValues((cur) => ({ ...cur, [fieldId]: new Date().toISOString().slice(0, 10) }));
      return;
    }
    if (f.type === 'CHECKBOX') {
      setValues((cur) => ({ ...cur, [fieldId]: cur[fieldId] === 'true' ? '' : 'true' }));
      return;
    }
    if (f.type === 'NAME' || f.type === 'EMAIL' || f.type === 'FORMULA' || f.type === 'NOTE' || f.type === 'LINE' || f.type === 'STAMP') {
      // FORMULA / NAME / EMAIL / NOTE / LINE / STAMP are display-only or
      // auto-filled — recipient interaction is a no-op.
      return;
    }
    if (f.type === 'APPROVE') {
      // One-click approval — stamps "Approved by <name> at <ISO ts>".
      const stamp = `Approved by ${props.recipient.name} at ${new Date().toISOString()}`;
      setValues((cur) => ({ ...cur, [fieldId]: cur[fieldId] === stamp ? '' : stamp }));
      return;
    }
    if (f.type === 'DECLINE') {
      // Shortcut into the global decline-with-reason flow.
      props.onDeclineClick();
      return;
    }
    if (f.type === 'ATTACHMENT') {
      // Trigger the hidden file input. The selected file is uploaded via
      // server action, then the attachments map updates.
      setUploadingFieldId(fieldId);
      setUploadError(null);
      // Reset value so picking the same file twice still triggers change.
      if (fileInputRef.current) fileInputRef.current.value = '';
      fileInputRef.current?.click();
      return;
    }
    setActiveFieldId(fieldId);
  }

  async function onAttachmentFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    const fieldId = uploadingFieldId;
    if (!file || !fieldId) return;
    const fd = new FormData();
    fd.append('token', props.token);
    fd.append('fieldId', fieldId);
    fd.append('file', file);
    try {
      const result = await uploadAttachmentAction({ ok: false }, fd);
      if (result.ok && result.attachment) {
        setAttachments((cur) => ({ ...cur, [fieldId]: result.attachment! }));
      } else {
        setUploadError(result.error ?? 'Upload failed.');
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploadingFieldId(null);
    }
  }

  return (
    <>
      {/* Progress strip */}
      <div className="bg-card border-b border-border px-6 lg:px-8 py-3 flex items-center gap-4">
        <div className="flex-1 max-w-md mx-auto">
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] text-faint text-center font-mono tabular-nums">
            {done} of {total} field{total === 1 ? '' : 's'} complete
          </p>
        </div>
      </div>

      {/* Banner */}
      <div className="bg-accent border-b border-primary/15 px-6 lg:px-8 py-2.5 flex items-center justify-center gap-2 text-[12.5px] text-accent-foreground">
        <PenIcon />
        Please review the document carefully. Use the checklist on the right to complete each field.
      </div>

      {/* Hidden file input shared by every ATTACHMENT field on the page —
          activate() picks the field, then triggers .click(); change-handler
          resolves which field to associate the upload with. */}
      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        onChange={onAttachmentFileChosen}
        aria-hidden="true"
        tabIndex={-1}
      />
      {uploadingFieldId && (
        <div role="status" className="absolute top-4 right-4 z-50 inline-flex items-center gap-2 rounded-md bg-canvas px-3 py-2 text-[12.5px] text-white shadow-lg">
          <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
          Uploading…
        </div>
      )}
      {uploadError && (
        <div
          role="alert"
          className="absolute top-4 right-4 z-50 inline-flex items-center gap-2 rounded-md bg-destructive-bg border border-destructive-border px-3 py-2 text-[12.5px] text-destructive shadow-lg"
        >
          {uploadError}
          <button
            type="button"
            onClick={() => setUploadError(null)}
            aria-label="Dismiss"
            className="hover:opacity-70"
          ><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
        </div>
      )}
      {/* Body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-0 min-h-0">
        {/* Document */}
        <main className="overflow-y-auto px-6 lg:px-10 py-8 bg-muted/30">
          <div className="mx-auto max-w-[820px] rounded-lg bg-card border border-border shadow-[0_4px_16px_rgba(15,17,21,0.06)] p-2 sm:p-3">
            <DocumentView
              token={props.token}
              title={props.envelopeTitle}
              renderPageOverlay={(pageNum) => (
                <>
                  {visibleFields
                    .filter((f) => f.page === pageNum)
                    .map((f) => {
                      // LINE is sender-drawn annotation only — render a flat
                      // black line, no button chrome, no interactivity.
                      if (f.type === 'LINE') {
                        return (
                          <span
                            key={f.id}
                            aria-hidden="true"
                            className="absolute pointer-events-none bg-foreground"
                            style={{
                              left: `${f.x * 100}%`,
                              top: `${(f.y + f.h / 2) * 100}%`,
                              width: `${f.w * 100}%`,
                              height: '2px',
                              transform: 'translateY(-1px)',
                            }}
                          />
                        );
                      }
                      // STAMP is a sender-uploaded image rendered on the doc.
                      // No interactivity, no button chrome.
                      if (f.type === 'STAMP') {
                        const src = f.stampImageBase64 && f.stampMimeType
                          ? `data:${f.stampMimeType};base64,${f.stampImageBase64}`
                          : null;
                        return (
                          <div
                            key={f.id}
                            aria-hidden="true"
                            className="absolute pointer-events-none flex items-center justify-center"
                            style={{
                              left: `${f.x * 100}%`,
                              top: `${f.y * 100}%`,
                              width: `${f.w * 100}%`,
                              height: `${f.h * 100}%`,
                            }}
                          >
                            {src ? (
                              <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                            ) : (
                              <span className="text-[10px] font-mono uppercase tracking-[0.06em] text-faint border border-dashed border-input rounded px-1 py-px">No stamp</span>
                            )}
                          </div>
                        );
                      }
                      const completed = isFieldComplete(f);
                      const isAuto = f.type === 'NAME' || f.type === 'EMAIL' || f.type === 'FORMULA' || f.type === 'NOTE';
                      const preview = f.type === 'NOTE'
                        ? (f.noteText ?? '')
                        : completed
                        ? renderCompletedPreview(f, values, signaturePng, typedSignature, initialsPng, typedInitials, formulaValues, attachments)
                        : null;
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => activate(f.id)}
                          aria-label={`${FIELD_LABEL[f.type] ?? f.type} field${f.required ? ', required' : ''}${completed ? ', completed' : ''}`}
                          disabled={isAuto && completed}
                          className={`absolute pointer-events-auto rounded-sm flex items-center justify-center text-[10px] sm:text-[11px] font-medium transition-all ${
                            completed
                              ? 'border-2 border-success bg-success-bg/70 text-success'
                              : 'border-2 border-status-progress bg-status-progress-bg/70 text-status-progress hover:bg-status-progress-bg'
                          } ${!completed && f.required ? 'sig-pulse' : ''} ${isAuto ? 'cursor-default' : 'cursor-pointer'}`}
                          style={{
                            left: `${f.x * 100}%`,
                            top: `${f.y * 100}%`,
                            width: `${f.w * 100}%`,
                            height: `${f.h * 100}%`,
                          }}
                        >
                          {completed && f.type === 'DRAWING' && values[f.id] ? (
                            <img src={values[f.id]!} alt="" className="max-h-full max-w-full object-contain" />
                          ) : completed && f.type === 'SIGNATURE' && signaturePng ? (
                            <img src={signaturePng} alt="" className="max-h-full max-w-full object-contain" />
                          ) : completed && f.type === 'SIGNATURE' && typedSignature ? (
                            <span className="font-sig text-[clamp(14px,3vw,28px)] leading-none truncate px-1" style={{ fontFamily: 'var(--font-sig), cursive', color: '#0F1115' }}>
                              {typedSignature}
                            </span>
                          ) : completed && f.type === 'INITIALS' && initialsPng ? (
                            <img src={initialsPng} alt="" className="max-h-full max-w-full object-contain" />
                          ) : completed && f.type === 'INITIALS' && typedInitials ? (
                            <span className="font-sig text-[clamp(14px,3vw,24px)] leading-none truncate px-1" style={{ fontFamily: 'var(--font-sig), cursive', color: '#0F1115' }}>
                              {typedInitials}
                            </span>
                          ) : completed ? (
                            <span className="px-1 truncate">{preview}</span>
                          ) : (
                            <span className="px-1 truncate flex items-center gap-1">
                              <FieldOverlayIcon type={f.type} />
                              <span>{overlayLabel(f.type)}</span>
                            </span>
                          )}
                        </button>
                      );
                    })}
                </>
              )}
            />
          </div>
        </main>

        {/* Right rail */}
        <aside className="bg-card border-l border-border flex flex-col min-h-0">
          <form action={formAction} className="flex-1 flex flex-col min-h-0">
            <input type="hidden" name="token" value={props.token} />
            <input
              type="hidden"
              name="fieldValues"
              value={JSON.stringify(
                Object.fromEntries(visibleFields.map((f) => [f.id, fieldValue(f)])),
              )}
            />
            {signaturePng && <input type="hidden" name="signatureImagePngBase64" value={signaturePng} />}
            {typedSignature && <input type="hidden" name="typedSignature" value={typedSignature} />}
            {signatureFont && <input type="hidden" name="signatureFont" value={signatureFont} />}
            {initialsPng && <input type="hidden" name="initialsImagePngBase64" value={initialsPng} />}
            {typedInitials && <input type="hidden" name="typedInitials" value={typedInitials} />}
            {initialsFont && <input type="hidden" name="initialsFont" value={initialsFont} />}

            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-[15px] font-semibold text-foreground">Required fields</h2>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">Complete every required field, then submit.</p>
            </div>

            <ul className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
              {visibleFields
                .filter((f) => f.type !== 'LINE' && f.type !== 'NOTE' && f.type !== 'STAMP')
                .map((f, i) => {
                const completed = isFieldComplete(f);
                const isAutoFilled = f.type === 'NAME' || f.type === 'EMAIL' || f.type === 'FORMULA';
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => activate(f.id)}
                      disabled={isAutoFilled}
                      className={`w-full text-left rounded-md border px-3 py-2.5 flex items-start gap-3 transition-colors ${
                        completed
                          ? 'border-success-border bg-success-bg/60'
                          : 'border-border bg-card hover:border-primary hover:bg-accent/30'
                      } ${!completed && f.required && !isAutoFilled ? 'sig-pulse' : ''} ${isAutoFilled ? 'cursor-default' : ''}`}
                      style={!completed && f.required && !isAutoFilled ? { boxShadow: '0 0 0 0 rgba(217,119,6,0.45)' } : undefined}
                    >
                      <span
                        className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold flex-shrink-0 ${
                          completed
                            ? 'bg-success text-white'
                            : 'bg-muted text-faint border border-input'
                        }`}
                      >
                        {completed ? <Check /> : i + 1}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-medium text-foreground">
                          {FIELD_LABEL[f.type] ?? f.type}
                          {isAutoFilled && (
                            <span className="ml-1 text-[10px] font-mono uppercase tracking-[0.05em] text-faint border border-border rounded px-1 py-px">auto-filled</span>
                          )}
                          {f.required && !completed && !isAutoFilled && <span className="ml-1 text-[10.5px] text-status-progress font-mono uppercase">required</span>}
                        </span>
                        <span className="block text-[11.5px] text-faint">
                          {completed ? renderCompletedPreview(f, values, signaturePng, typedSignature, initialsPng, typedInitials, formulaValues, attachments) : `Page ${f.page} · click to fill`}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {state.error && (
              <div role="alert" className="mx-3 mb-3 rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-[12.5px] text-destructive">
                {state.error}
              </div>
            )}

            <div className="px-5 py-4 border-t border-border space-y-2">
              <SignSubmit
                disabled={requiredMissing}
                label={props.recipient.role === 'APPROVER' ? 'Approve & complete' : undefined}
              />
              <button
                type="button"
                onClick={props.onDeclineClick}
                className="w-full text-center text-[12.5px] text-faint hover:text-destructive"
              >
                Decline to sign
              </button>
              <button
                type="button"
                onClick={props.onReassignClick}
                className="w-full text-center text-[12.5px] text-faint hover:text-primary"
              >
                Forward to someone else
              </button>
              <CommentsThread token={props.token} comments={props.comments} />
              <button
                type="button"
                onClick={() => {
                  setDraftSavedToast(true);
                  setTimeout(() => setDraftSavedToast(false), 2500);
                }}
                className="w-full text-center text-[12.5px] text-faint hover:text-foreground"
                title="Your in-progress values are auto-saved on this device. You can close the tab and come back via your original signing email."
              >
                Save & finish later
              </button>
              {draftSavedToast && (
                <p role="status" className="text-center text-[11.5px] text-success">
                  ✓ Saved to this browser. Re-open your signing link to resume.
                </p>
              )}
            </div>

            <div className="px-5 py-3 border-t border-border bg-muted/30 text-[11px] text-faint space-y-1">
              <div className="flex items-center justify-between">
                <span>Sent by</span>
                <span className="text-muted-foreground truncate ml-2">{props.senderName}</span>
              </div>
              {props.senderEmail && (
                <div className="flex items-center justify-between">
                  <span>Email</span>
                  <span className="text-muted-foreground font-mono truncate ml-2">{props.senderEmail}</span>
                </div>
              )}
              {props.message && (
                <div className="pt-2 mt-2 border-t border-border">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">Note from sender</p>
                  <p className="mt-1 text-[12px] text-muted-foreground leading-snug whitespace-pre-wrap">{props.message}</p>
                </div>
              )}
            </div>
          </form>
        </aside>
      </div>

      {/* Field-entry modal */}
      <Dialog open={activeFieldId !== null} onOpenChange={(o) => { if (!o) setActiveFieldId(null); }}>
        {(() => {
          const f = props.fields.find((x) => x.id === (activeFieldId ?? lastActiveFieldIdRef.current));
          if (!f) return null;
          if (f.type === 'SIGNATURE') {
            return (
              <SignatureModal
                kind="SIGNATURE"
                recipientName={props.recipient.name}
                initialPng={signaturePng}
                initialTyped={typedSignature}
                onCancel={() => setActiveFieldId(null)}
                onAdopt={({ png, typed, font }) => {
                  if (png) {
                    setSignaturePng(png);
                    setTypedSignature(typed ?? '');
                    setSignatureFont(font ?? null);
                  } else if (typed) {
                    setTypedSignature(typed);
                    setSignaturePng(null);
                    setSignatureFont(font ?? null);
                  } else {
                    setSignaturePng(null);
                    setTypedSignature('');
                    setSignatureFont(null);
                  }
                  setActiveFieldId(null);
                }}
              />
            );
          }
          if (f.type === 'INITIALS') {
            // Default the typed initials to the recipient's actual initials
            // (first letter of each name part) so the Type tab is one click + adopt.
            const recipientInitials = props.recipient.name
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map((p) => p[0])
              .slice(0, 3)
              .join('')
              .toUpperCase();
            return (
              <SignatureModal
                kind="INITIALS"
                recipientName={recipientInitials || props.recipient.name}
                initialPng={initialsPng}
                initialTyped={typedInitials}
                onCancel={() => setActiveFieldId(null)}
                onAdopt={({ png, typed, font }) => {
                  if (png) {
                    setInitialsPng(png);
                    setTypedInitials(typed ?? '');
                    setInitialsFont(font ?? null);
                  } else if (typed) {
                    setTypedInitials(typed);
                    setInitialsPng(null);
                    setInitialsFont(font ?? null);
                  } else {
                    setInitialsPng(null);
                    setTypedInitials('');
                    setInitialsFont(null);
                  }
                  setActiveFieldId(null);
                }}
              />
            );
          }
          if (f.type === 'DRAWING') {
            return (
              <DrawingModal
                field={f}
                initialDataUrl={values[f.id] ?? null}
                onCancel={() => setActiveFieldId(null)}
                onSave={(dataUrl) => {
                  setValues((cur) => ({ ...cur, [f.id]: dataUrl }));
                  setActiveFieldId(null);
                }}
              />
            );
          }
          if (f.type === 'DROPDOWN' || f.type === 'RADIO') {
            return (
              <OptionPickerModal
                field={f}
                value={values[f.id] ?? ''}
                onCancel={() => setActiveFieldId(null)}
                onSave={(v) => { setValues((cur) => ({ ...cur, [f.id]: v })); setActiveFieldId(null); }}
              />
            );
          }
          // TEXT / NUMBER / JOB_TITLE / PHONE / ADDRESS / COMPANY (text-y modal entry)
          return (
            <ValueModal
              field={f}
              value={values[f.id] ?? ''}
              onCancel={() => setActiveFieldId(null)}
              onSave={(v) => { setValues((cur) => ({ ...cur, [f.id]: v })); setActiveFieldId(null); }}
            />
          );
        })()}
      </Dialog>
    </>
  );
}

function renderCompletedPreview(
  f: FieldDef,
  values: Record<string, string>,
  signaturePng: string | null,
  typedSignature: string,
  initialsPng: string | null,
  typedInitials: string,
  formulaValues: Record<string, string>,
  attachments: Record<string, { filename: string; sizeBytes: number; sha256: string }>,
): string {
  if (f.type === 'SIGNATURE') {
    if (signaturePng) return 'Drawn signature adopted';
    if (typedSignature) return `Typed: ${typedSignature}`;
    return 'Adopted';
  }
  if (f.type === 'INITIALS') {
    if (initialsPng) return 'Drawn initials adopted';
    if (typedInitials) return `Typed: ${typedInitials}`;
    return 'Adopted';
  }
  if (f.type === 'CHECKBOX') return 'Acknowledged';
  if (f.type === 'FORMULA') return formulaValues[f.id] ?? '';
  if (f.type === 'ATTACHMENT') {
    const a = attachments[f.id];
    return a ? a.filename : 'Uploaded';
  }
  if (f.type === 'APPROVE') return values[f.id] ?? 'Approved';
  if (f.type === 'NOTE') return ''; // rendered separately as static text
  if (f.type === 'DECLINE') return values[f.id] ?? '';
  if (f.type === 'DATE') {
    const v = values[f.id];
    return v ? new Date(v).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Today';
  }
  return values[f.id] ?? '';
}

/** Compact icon used in unfilled field overlays. Inline SVG, no emoji. */
function FieldOverlayIcon({ type }: { type: string }) {
  const props = { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2 as const, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (type) {
    case 'SIGNATURE':
    case 'INITIALS':
    case 'TEXT':
      return (<svg {...props}><path d="M3 17l6-6 4 4 8-8" /><path d="M3 21h18" /></svg>);
    case 'DATE':
      return (<svg {...props}><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>);
    case 'CHECKBOX':
      return (<svg {...props}><rect x="4" y="4" width="16" height="16" rx="2" /></svg>);
    case 'NAME':
      return (<svg {...props}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>);
    case 'EMAIL':
      return (<svg {...props}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22 6 12 13 2 6" /></svg>);
    case 'JOB_TITLE':
      return (<svg {...props}><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></svg>);
    case 'NUMBER':
      return (<svg {...props}><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></svg>);
    case 'PHONE':
      return (<svg {...props}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>);
    case 'ADDRESS':
      return (<svg {...props}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>);
    case 'COMPANY':
      return (<svg {...props}><path d="M3 21V7l9-4 9 4v14" /><line x1="3" y1="21" x2="21" y2="21" /></svg>);
    case 'DROPDOWN':
      return (<svg {...props}><rect x="3" y="6" width="18" height="12" rx="2" /><polyline points="9 11 12 14 15 11" /></svg>);
    case 'RADIO':
      return (<svg {...props}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" /></svg>);
    case 'FORMULA':
      return (<svg {...props}><path d="M6 4l4 16M14 4l4 16" /><line x1="3" y1="12" x2="21" y2="12" /></svg>);
    case 'ATTACHMENT':
      return (<svg {...props}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>);
    case 'APPROVE':
      return (<svg {...props}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>);
    case 'DECLINE':
      return (<svg {...props}><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>);
    case 'NOTE':
      return (<svg {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>);
    default:
      return null;
  }
}

function overlayLabel(type: string): string {
  switch (type) {
    case 'SIGNATURE': return 'Sign here';
    case 'INITIALS':  return 'Initial';
    case 'DATE':      return 'Date';
    case 'CHECKBOX':  return 'Acknowledge';
    case 'TEXT':      return 'Fill text';
    case 'NUMBER':    return 'Number';
    case 'NAME':      return 'Name (auto)';
    case 'EMAIL':     return 'Email (auto)';
    case 'JOB_TITLE': return 'Job title';
    case 'PHONE':     return 'Phone';
    case 'ADDRESS':   return 'Address';
    case 'COMPANY':   return 'Company';
    case 'DROPDOWN':  return 'Choose…';
    case 'RADIO':     return 'Choose…';
    case 'FORMULA':   return 'Calculated';
    case 'ATTACHMENT':return 'Upload file';
    case 'APPROVE':   return 'Approve';
    case 'DECLINE':   return 'Decline';
    case 'NOTE':      return 'Note';
    default: return type;
  }
}

/* ─── Signature modal ──────────────────────────────────────────── */
function SignatureModal({
  kind,
  recipientName,
  initialPng,
  initialTyped,
  onCancel,
  onAdopt,
}: {
  kind: 'SIGNATURE' | 'INITIALS';
  recipientName: string;
  initialPng: string | null;
  initialTyped: string;
  onCancel: () => void;
  onAdopt: (args: { png?: string | null; typed?: string; font?: SignatureFontKey }) => void;
}) {
  const [tab, setTab] = useState<'draw' | 'type'>('draw');
  const [typed, setTyped] = useState(initialTyped || recipientName);
  const [font, setFont] = useState<SignatureFontKey>(DEFAULT_SIGNATURE_FONT);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasStrokes, setHasStrokes] = useState(false);
  // Quadratic-curve smoothing state. Each move replays a curve from the
  // previous midpoint to the new midpoint, using the previous raw point as
  // the control. That collapses jagged sample-to-sample line segments into
  // smooth strokes that feel like a real pen.
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastMidRef = useRef<{ x: number; y: number } | null>(null);

  // Bitmap sizing uses offsetWidth/Height — the LAYOUT box, unaffected by
  // the dialog's entrance-animation transform (getBoundingClientRect would
  // bake the mid-animation scale in). The sizing also runs lazily at
  // pointer-down: passive effects can be deferred past first paint when the
  // main thread is busy rendering PDF pages, and the user can start drawing
  // before the effect ever ran.
  function syncCanvasSize() {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.offsetWidth * dpr);
    const h = Math.round(c.offsetHeight * dpr);
    if (c.width === w && c.height === h) return;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0F1115';
    ctx.lineWidth = 2.6;
  }

  useEffect(() => {
    if (tab !== 'draw') return;
    syncCanvasSize();
  }, [tab]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const c = canvasRef.current!;
    syncCanvasSize();
    c.setPointerCapture(e.pointerId);
    const p = pointFromEvent(e);
    lastPointRef.current = p;
    lastMidRef.current = p;
    setHasStrokes(true);
    // Draw a single dot so taps without drag still leave a mark.
    const ctx = c.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fill();
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.buttons === 0) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pointFromEvent(e);
    const lastP = lastPointRef.current;
    const lastMid = lastMidRef.current;
    if (!lastP || !lastMid) {
      lastPointRef.current = p;
      lastMidRef.current = p;
      return;
    }
    // Coalesced events let us catch the high-rate pointer samples that
    // browsers throttle on slow JS frames — strokes stay smooth even when
    // the main thread is busy with PDF re-layouts.
    const all = (e.nativeEvent as PointerEvent).getCoalescedEvents
      ? (e.nativeEvent as PointerEvent).getCoalescedEvents()
      : [e.nativeEvent as PointerEvent];
    let prevP = lastP;
    let prevMid = lastMid;
    for (const ce of all) {
      const cp = (() => {
        const c = canvasRef.current!;
        const rect = c.getBoundingClientRect();
        return { x: ce.clientX - rect.left, y: ce.clientY - rect.top };
      })();
      const mid = { x: (prevP.x + cp.x) / 2, y: (prevP.y + cp.y) / 2 };
      ctx.beginPath();
      ctx.moveTo(prevMid.x, prevMid.y);
      ctx.quadraticCurveTo(prevP.x, prevP.y, mid.x, mid.y);
      ctx.stroke();
      prevP = cp;
      prevMid = mid;
    }
    lastPointRef.current = prevP;
    lastMidRef.current = prevMid;
  }
  function onPointerUp() {
    // Connect the trailing midpoint to the actual last raw point so the
    // stroke ends where the user actually lifted, not at the last midpoint.
    const lastP = lastPointRef.current;
    const lastMid = lastMidRef.current;
    if (lastP && lastMid && (lastP.x !== lastMid.x || lastP.y !== lastMid.y)) {
      const ctx = canvasRef.current!.getContext('2d')!;
      ctx.beginPath();
      ctx.moveTo(lastMid.x, lastMid.y);
      ctx.lineTo(lastP.x, lastP.y);
      ctx.stroke();
    }
    lastPointRef.current = null;
    lastMidRef.current = null;
  }
  function clearPad() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    setHasStrokes(false);
  }

  /**
   * Trim the transparent margin around the drawn signature, then return a
   * data URL of just the inked region (with a small padding). Saves bandwidth
   * AND makes the signature stamp fit nicely inside its placed-field box on
   * the sealed PDF.
   */
  function exportTrimmedPng(): string | null {
    const c = canvasRef.current;
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return c.toDataURL('image/png');
    const { width, height } = c;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4 + 3; // alpha channel
        if (data[i] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // empty
    const pad = 8;
    const sx = Math.max(0, minX - pad);
    const sy = Math.max(0, minY - pad);
    const sw = Math.min(width - sx, maxX - minX + 1 + pad * 2);
    const sh = Math.min(height - sy, maxY - minY + 1 + pad * 2);
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const outCtx = out.getContext('2d');
    if (!outCtx) return c.toDataURL('image/png');
    outCtx.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL('image/png');
  }

  /**
   * Render the typed signature in the chosen cursive font to a canvas
   * and return a trimmed PNG. The seal pipeline then stamps the actual
   * cursive glyphs (as a raster) onto the sealed PDF, matching what the
   * recipient saw on screen — no need to embed custom fonts in pdf-lib.
   */
  function renderTypedToPng(): string | null {
    const text = typed.trim();
    if (!text) return null;
    const f = fontByKey(font);
    // Render at high resolution so the stamp stays crisp on the sealed PDF.
    // Ceremony preview size is ~40px line; we scale to ~120px for headroom.
    const scratch = document.createElement('canvas');
    const ctx = scratch.getContext('2d');
    if (!ctx) return null;
    const fontSize = 120;
    const cssFamily = f.cssFamily.replace(/, cursive$/, '') + ', cursive';
    ctx.font = `${fontSize}px ${cssFamily}`;
    const metrics = ctx.measureText(text);
    const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.85;
    const descent = metrics.actualBoundingBoxDescent || fontSize * 0.35;
    const pad = 16;
    const w = Math.max(1, Math.ceil(metrics.width + pad * 2));
    const h = Math.max(1, Math.ceil(ascent + descent + pad * 2));
    scratch.width = w;
    scratch.height = h;
    const ctx2 = scratch.getContext('2d');
    if (!ctx2) return null;
    ctx2.font = `${fontSize}px ${cssFamily}`;
    ctx2.fillStyle = '#0F1115';
    ctx2.textBaseline = 'alphabetic';
    ctx2.fillText(text, pad, pad + ascent);
    return scratch.toDataURL('image/png');
  }

  function adopt() {
    if (tab === 'draw') {
      if (!hasStrokes) return;
      const png = exportTrimmedPng();
      onAdopt({ png });
    } else {
      const text = typed.trim();
      if (!text) return;
      const png = renderTypedToPng();
      onAdopt({ png, typed: text, font });
    }
  }

  return (
    <DialogContent className="max-w-[560px]">
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle className="text-[18px] tracking-[-0.018em]">
          Adopt your {kind === 'SIGNATURE' ? 'signature' : 'initials'}
        </DialogTitle>
        <DialogDescription>
          This {kind === 'SIGNATURE' ? 'signature' : 'mark'} will be applied to the document and is legally binding.
        </DialogDescription>
      </DialogHeader>

      <div className="px-6 pt-4">
        <div className="inline-flex border-b border-border -mb-px">
          <TabBtn active={tab === 'draw'} onClick={() => setTab('draw')}>Draw</TabBtn>
          <TabBtn active={tab === 'type'} onClick={() => setTab('type')}>Type</TabBtn>
        </div>
      </div>

      {tab === 'draw' && (
        <div className="px-6 pt-4 pb-2">
          <div className="relative h-[180px] rounded-md border border-border bg-muted/30 overflow-hidden">
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={onPointerUp}
              className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
              aria-label={`Draw your ${kind === 'SIGNATURE' ? 'signature' : 'initials'}`}
            />
            {!hasStrokes && (
              <p className="absolute inset-0 flex items-center justify-center text-[14px] text-faint italic pointer-events-none">
                Draw your {kind === 'SIGNATURE' ? 'signature' : 'initials'} here
              </p>
            )}
          </div>
          <div className="mt-2 flex justify-end">
            <button type="button" onClick={clearPad} className="text-[12.5px] text-faint hover:text-foreground underline">
              Clear
            </button>
          </div>
        </div>
      )}

      {tab === 'type' && (
        <div className="px-6 pt-4 pb-2">
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            placeholder="Type your full name"
            className="w-full h-11 px-3 rounded-md border border-border bg-card text-[16px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
          />
          <div className="mt-3 h-[120px] rounded-md border border-border bg-muted/30 flex items-center justify-center px-6 overflow-hidden">
            <span
              className="text-[40px] leading-none text-foreground truncate"
              style={{ fontFamily: fontByKey(font).cssFamily }}
            >
              {typed || 'Your signature'}
            </span>
          </div>
          <p className="mt-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-faint">
            Pick a style
          </p>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {SIGNATURE_FONTS.map((f) => {
              const active = f.key === font;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFont(f.key)}
                  aria-pressed={active}
                  aria-label={`Use ${f.label} style`}
                  className={`flex items-center justify-center h-12 px-3 rounded-md border text-[20px] leading-none truncate transition-colors ${
                    active
                      ? 'border-primary bg-accent/40 text-foreground ring-1 ring-primary/20'
                      : 'border-border bg-card text-foreground hover:bg-muted/60'
                  }`}
                  style={{ fontFamily: f.cssFamily }}
                >
                  {(typed || 'Your name').slice(0, 18)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-foreground hover:bg-muted/60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={adopt}
          disabled={tab === 'type' ? !typed.trim() : !hasStrokes}
          className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Adopt &amp; sign
        </button>
      </div>
    </DialogContent>
  );
}

/* ─── Drawing modal ──────────────────────────────────────────────
 * A draw-only canvas for DRAWING-typed fields. Captures a freeform
 * mark (diagram, doodle, freehand notation) as a trimmed PNG data URL
 * stored in `values[fieldId]`. The seal pipeline stamps it onto the
 * sealed PDF the same way it stamps a signature image.
 */
function DrawingModal({
  field, initialDataUrl, onCancel, onSave,
}: {
  field: FieldDef;
  initialDataUrl: string | null;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasStrokes, setHasStrokes] = useState(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastMidRef = useRef<{ x: number; y: number } | null>(null);

  // Bitmap sizing uses the layout box (offsetWidth/Height), unaffected by
  // the dialog entrance animation, and repairs lazily at pointer-down in
  // case this passive effect hasn't run before the user starts drawing.
  function syncCanvasSize(): boolean {
    const c = canvasRef.current;
    if (!c) return false;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.offsetWidth * dpr);
    const h = Math.round(c.offsetHeight * dpr);
    if (c.width === w && c.height === h) return false;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0F1115';
    ctx.lineWidth = 2.4;
    return true;
  }

  /** Re-draw the previously saved mark so the recipient can extend or clear it. */
  function restoreMark() {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !initialDataUrl) return;
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, c.offsetWidth, c.offsetHeight);
      setHasStrokes(true);
    };
    img.src = initialDataUrl;
  }

  useEffect(() => {
    syncCanvasSize();
    restoreMark();
  }, [initialDataUrl]);

  function pt(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const c = canvasRef.current!;
    if (syncCanvasSize()) restoreMark();
    c.setPointerCapture(e.pointerId);
    const p = pt(e);
    lastPointRef.current = p;
    lastMidRef.current = p;
    setHasStrokes(true);
    const ctx = c.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fill();
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.buttons === 0) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pt(e);
    const lastP = lastPointRef.current;
    const lastMid = lastMidRef.current;
    if (!lastP || !lastMid) {
      lastPointRef.current = p;
      lastMidRef.current = p;
      return;
    }
    const mid = { x: (lastP.x + p.x) / 2, y: (lastP.y + p.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(lastMid.x, lastMid.y);
    ctx.quadraticCurveTo(lastP.x, lastP.y, mid.x, mid.y);
    ctx.stroke();
    lastPointRef.current = p;
    lastMidRef.current = mid;
  }
  function up() {
    lastPointRef.current = null;
    lastMidRef.current = null;
  }
  function clearPad() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    setHasStrokes(false);
  }
  function exportTrimmed(): string | null {
    const c = canvasRef.current;
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return c.toDataURL('image/png');
    const { width, height } = c;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const pad = 6;
    const sx = Math.max(0, minX - pad);
    const sy = Math.max(0, minY - pad);
    const sw = Math.min(width - sx, maxX - minX + 1 + pad * 2);
    const sh = Math.min(height - sy, maxY - minY + 1 + pad * 2);
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const outCtx = out.getContext('2d');
    if (!outCtx) return c.toDataURL('image/png');
    outCtx.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL('image/png');
  }
  function save() {
    if (!hasStrokes) return;
    const png = exportTrimmed();
    if (png) onSave(png);
  }

  return (
    <DialogContent className="max-w-[640px]">
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle className="text-[18px] tracking-[-0.018em]">Drawing</DialogTitle>
        <DialogDescription>
          Draw a mark, sketch, or freehand notation. It will be stamped into the document at this field&apos;s position.
        </DialogDescription>
      </DialogHeader>
      <div className="px-6 pt-4 pb-2">
        <div className="relative h-[280px] rounded-md border border-border bg-muted/30 overflow-hidden">
          <canvas
            ref={canvasRef}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={up}
            className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
            aria-label="Drawing canvas"
          />
          {!hasStrokes && (
            <p className="absolute inset-0 flex items-center justify-center text-[14px] text-faint italic pointer-events-none">
              Click and drag to draw
            </p>
          )}
        </div>
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={clearPad} className="text-[12.5px] text-faint hover:text-foreground underline">
            Clear
          </button>
        </div>
      </div>
      <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-foreground hover:bg-muted/60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!hasStrokes}
          className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Save drawing
        </button>
      </div>
    </DialogContent>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-4 h-9 -mb-px text-[13px] font-medium border-b-2 transition-colors ${
        active ? 'border-primary text-foreground' : 'border-transparent text-faint hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/* ─── Text/number value modal ──────────────────────────────────── */
function ValueModal({
  field, value, onCancel, onSave,
}: {
  field: FieldDef;
  value: string;
  onCancel: () => void;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  const inputType =
    field.type === 'NUMBER' ? 'number' :
    field.type === 'PHONE'  ? 'tel'    :
    field.type === 'EMAIL'  ? 'email'  : 'text';
  const isMultiline = field.type === 'ADDRESS';
  const limit = field.charLimit;
  const validationError = (() => {
    if (!v.trim()) return null; // emptiness handled by required gate, not here
    if (field.type === 'NUMBER') {
      const n = Number(v);
      if (Number.isNaN(n)) return 'Enter a number.';
      if (field.min !== undefined && n < field.min) return `Must be at least ${field.min}.`;
      if (field.max !== undefined && n > field.max) return `Must be at most ${field.max}.`;
    }
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(v)) {
          return field.patternMessage || 'Value does not match the required format.';
        }
      } catch {
        // sender-supplied bad regex — surface a generic message instead of crashing
        return 'Field validation is misconfigured. Contact the sender.';
      }
    }
    return null;
  })();
  function onChange(next: string) {
    setV(limit ? next.slice(0, limit) : next);
  }
  const canSave = (!field.required || v.trim().length > 0) && !validationError;
  return (
    <DialogContent className="max-w-[420px]" aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>Enter {FIELD_LABEL[field.type] ?? field.type}</DialogTitle>
      </DialogHeader>
      <div className="px-5 py-4">
        {isMultiline ? (
          <textarea
            value={v}
            onChange={(e) => onChange(e.currentTarget.value)}
            autoFocus
            rows={3}
            maxLength={limit}
            aria-invalid={!!validationError}
            className="w-full px-3 py-2 rounded-md border border-border bg-card text-[14px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12 resize-none"
          />
        ) : (
          <input
            type={inputType}
            value={v}
            onChange={(e) => onChange(e.currentTarget.value)}
            autoFocus
            maxLength={limit}
            min={field.type === 'NUMBER' ? field.min : undefined}
            max={field.type === 'NUMBER' ? field.max : undefined}
            aria-invalid={!!validationError}
            className="w-full h-10 px-3 rounded-md border border-border bg-card text-[14px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
          />
        )}
        <div className="mt-1.5 flex items-center justify-between gap-2 min-h-[1rem]">
          <span className="text-[11.5px] text-destructive" role="alert">
            {validationError ?? ''}
          </span>
          {limit && (
            <span className="text-[11px] text-faint tabular-nums">
              {v.length} / {limit}
            </span>
          )}
        </div>
      </div>
      <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-foreground hover:bg-muted/60">
          Cancel
        </button>
        <button type="button" onClick={() => onSave(v)} disabled={!canSave} className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep disabled:opacity-40 disabled:cursor-not-allowed">
          Save
        </button>
      </div>
    </DialogContent>
  );
}

/* DROPDOWN / RADIO option picker — recipient must choose one of the
   sender-defined options. DROPDOWN renders a styled select, RADIO renders
   a vertical radio group. The chosen value is the option string itself. */
function OptionPickerModal({
  field, value, onCancel, onSave,
}: {
  field: FieldDef;
  value: string;
  onCancel: () => void;
  onSave: (v: string) => void;
}) {
  const options = field.options ?? [];
  const [v, setV] = useState(value);
  const canSave = !field.required || v !== '';
  const heading = field.type === 'DROPDOWN' ? 'Pick an option' : 'Choose one';
  return (
    <DialogContent className="max-w-[420px]" aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>{heading}</DialogTitle>
      </DialogHeader>
      <div className="px-5 py-4">
        {options.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            The sender hasn&apos;t configured options for this field. Contact them for help.
          </p>
        ) : field.type === 'DROPDOWN' ? (
          <Select
            value={v}
            onChange={setV}
            placeholder="— Select —"
            ariaLabel="Choose an option"
            options={options.map((o) => ({ value: o, label: o }))}
          />
        ) : (
          <div role="radiogroup" className="space-y-1.5">
            {options.map((o) => {
              const selected = v === o;
              return (
                <label
                  key={o}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-md border cursor-pointer transition-colors ${
                    selected
                      ? 'border-primary bg-accent/60'
                      : 'border-border bg-card hover:bg-muted/60'
                  }`}
                >
                  <input
                    type="radio"
                    name={`opt-${field.id}`}
                    value={o}
                    checked={selected}
                    onChange={() => setV(o)}
                    className="sr-only"
                  />
                  <span className={`relative inline-flex h-4 w-4 items-center justify-center rounded-full border ${selected ? 'border-primary' : 'border-input'}`}>
                    {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  <span className="text-[13.5px] text-foreground">{o}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-foreground hover:bg-muted/60">
          Cancel
        </button>
        <button type="button" onClick={() => onSave(v)} disabled={!canSave} className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep disabled:opacity-40 disabled:cursor-not-allowed">
          Save
        </button>
      </div>
    </DialogContent>
  );
}

/* ─── Submit + decline ─────────────────────────────────────────── */
function SignSubmit({ disabled, label }: { disabled?: boolean; label?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex w-full h-10 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13.5px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {pending ? 'Sealing…' : (<>{label ?? 'Finish & submit'} <Check /></>)}
    </button>
  );
}

function ReassignDialog({
  token, currentEmail, onCancel, onReassigned,
}: {
  token: string;
  currentEmail: string;
  onCancel: () => void;
  onReassigned: (msg: string) => void;
}) {
  const [state, action] = useActionState(reassignAction, { ok: false } as { ok: boolean; error?: string; message?: string });
  useEffect(() => {
    if (state.ok && state.message) onReassigned(state.message);
  }, [state, onReassigned]);
  return (
    <DialogContent className="max-w-[440px]">
      <DialogHeader>
        <DialogTitle>Forward to someone else</DialogTitle>
        <DialogDescription>
          The new person will get a fresh signing link by email. Your previous email <span className="font-mono text-foreground">{currentEmail}</span> stays in the audit chain.
        </DialogDescription>
      </DialogHeader>
      <form action={action} className="px-5 py-4 space-y-3">
        <input type="hidden" name="token" value={token} />
        <label className="block">
          <span className="block text-[12px] font-medium text-muted-foreground mb-1">Their full name</span>
          <input
            type="text"
            name="newName"
            required
            maxLength={120}
            autoFocus
            className="w-full h-9 px-3 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
          />
        </label>
        <label className="block">
          <span className="block text-[12px] font-medium text-muted-foreground mb-1">Their email</span>
          <input
            type="email"
            name="newEmail"
            required
            className="w-full h-9 px-3 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
          />
        </label>
        <label className="block">
          <span className="block text-[12px] font-medium text-muted-foreground mb-1">Reason <span className="text-faint font-normal">(optional)</span></span>
          <textarea
            name="reason"
            rows={2}
            maxLength={500}
            placeholder="e.g. I'm out of office; please ask my colleague."
            className="w-full px-3 py-2 rounded-md border border-border bg-card text-[13px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12 resize-none"
          />
        </label>
        {state.error && <p className="text-[12px] text-destructive">{state.error}</p>}
        <div className="pt-2 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-foreground hover:bg-muted/60"
          >
            Cancel
          </button>
          <ReassignSubmitBtn />
        </div>
      </form>
    </DialogContent>
  );
}

function ReassignSubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep disabled:opacity-50"
    >
      {pending ? 'Forwarding…' : 'Send forward'}
    </button>
  );
}

function DeclineDialog({
  token, onCancel, onDeclined,
}: {
  token: string;
  onCancel: () => void;
  onDeclined: (msg: string) => void;
}) {
  const [state, formAction] = useActionState(declineAction, initial);
  useEffect(() => { if (state.ok) onDeclined(state.message ?? 'Declined.'); }, [state.ok, state.message, onDeclined]);
  return (
    <DialogContent>
      <form action={formAction}>
        <input type="hidden" name="token" value={token} />
        <DialogHeader>
          <DialogTitle>Decline to sign</DialogTitle>
          <DialogDescription>Tell the sender why. They&apos;ll be notified.</DialogDescription>
        </DialogHeader>
        <div className="px-5 py-4">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted-foreground">Reason</span>
            <textarea
              name="reason"
              required
              rows={3}
              className="px-3 py-2 rounded-md border border-border bg-card text-[13.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
            />
          </label>
          {state.error && (
            <div role="alert" className="mt-3 rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-[12.5px] text-destructive">
              {state.error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="inline-flex h-9 items-center px-3 rounded-md border border-border bg-card text-[13px] font-medium text-foreground hover:bg-muted/60">
            Cancel
          </button>
          <DeclineSubmit />
        </div>
      </form>
    </DialogContent>
  );
}
function DeclineSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex h-9 items-center px-4 rounded-md bg-destructive text-white text-[13px] font-medium hover:opacity-90 disabled:opacity-50">
      {pending ? 'Declining…' : 'Decline'}
    </button>
  );
}

/* ─── Success / declined screens ───────────────────────────────── */
function SuccessScreen({
  title, sub, tone = 'success', isSignedIn,
}: { title: string; sub: string; tone?: 'success' | 'declined'; isSignedIn: boolean }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <span
          className={`inline-flex h-16 w-16 items-center justify-center rounded-full ${
            tone === 'success' ? 'bg-success-bg text-success' : 'bg-destructive-bg text-destructive'
          }`}
          style={{ animation: 'fade-up 500ms ease-out both' }}
        >
          {tone === 'success' ? <BigCheck /> : <BigX />}
        </span>
        <h1 className="mt-6 text-[26px] font-semibold tracking-[-0.022em] text-foreground">{title}</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">{sub}</p>
        <div className="mt-6 flex flex-col gap-2 items-center">
          {isSignedIn ? (
            <>
              <a
                href="/DocuRidge/dashboard/inbox"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors"
              >
                Go to my inbox
              </a>
              <a
                href="/DocuRidge/dashboard"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-4 text-[13px] font-medium text-foreground hover:bg-muted/60 transition-colors"
              >
                Back to dashboard
              </a>
            </>
          ) : (
            <a
              href="/DocuRidge/login"
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors"
            >
              Sign in to DocuRidge
            </a>
          )}
          <p className="mt-2 text-[11.5px] text-faint">You can also safely close this page.</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Icons ────────────────────────────────────────────────────── */
function Check() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>); }
function ChevronRight() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>); }
function ShieldIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>); }
function PenIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>); }
function BigCheck() { return (<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>); }
function BigX() { return (<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>); }

const commentInitial: CommentActionState = { ok: false };

/**
 * Disclosure-style comment thread inside the signing ceremony's right rail.
 * Collapsed by default to keep the action checklist front-and-center;
 * shows a "(N)" badge when comments exist so the recipient knows there's
 * something to read.
 */
function CommentsThread({
  token, comments,
}: {
  token: string;
  comments: Array<{ id: string; authorName: string; isSender: boolean; isOwnPost: boolean; body: string; createdAt: string }>;
}) {
  const [open, setOpen] = useState(comments.length > 0);
  const [state, action] = useActionState(addCommentRecipientAction, commentInitial);
  const [body, setBody] = useState('');
  useEffect(() => {
    if (state.ok) setBody('');
  }, [state]);
  return (
    <div className="border-t border-border -mx-3 px-3 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-[12px] font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <span>
          Discussion {comments.length > 0 && <span className="text-faint">({comments.length})</span>}
        </span>
        <span className="text-faint">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {comments.length === 0 ? (
            <p className="text-[11.5px] text-faint">No comments yet.</p>
          ) : (
            <ul className="max-h-[200px] overflow-y-auto pr-1 space-y-2">
              {comments.map((c) => (
                <li key={c.id} className={`rounded-md px-2.5 py-1.5 text-[12px] leading-snug border ${
                  c.isSender
                    ? 'bg-accent/50 border-primary/15'
                    : 'bg-muted border-border'
                }`}>
                  <p className="text-[10px] font-mono uppercase tracking-[0.05em] text-faint mb-0.5">
                    {c.authorName} · {c.isSender ? 'sender' : 'recipient'}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
          <form action={action} className="space-y-1">
            <input type="hidden" name="token" value={token} />
            <textarea
              name="body"
              rows={2}
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              maxLength={4000}
              placeholder="Reply to the sender…"
              className="w-full px-2.5 py-1.5 rounded-md border border-border bg-card text-[12.5px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12 resize-none"
            />
            {state.error && <p className="text-[11px] text-destructive">{state.error}</p>}
            <CommentPostBtn disabled={!body.trim()} />
          </form>
        </div>
      )}
    </div>
  );
}

function CommentPostBtn({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex h-7 items-center px-2.5 rounded-md bg-primary text-[11.5px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Posting…' : 'Post'}
    </button>
  );
}
