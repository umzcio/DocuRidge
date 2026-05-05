'use client';

import { useActionState, useRef, useState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import {
  consentAction,
  submitSigningAction,
  declineAction,
  type SignActionState,
} from './actions';
import { DocumentView } from './document-view';

interface FieldDef {
  id: string;
  type: string;
  page: number;
  required: boolean;
  defaultValue?: string | null;
}

const initial: SignActionState = { ok: false };

interface Props {
  token: string;
  envelopeTitle: string;
  senderName: string;
  senderEmail: string;
  message?: string | null;
  recipient: { id: string; name: string; email: string };
  fields: FieldDef[];
  consentAlreadyGiven: boolean;
}

export function SigningCeremony(props: Props) {
  const [phase, setPhase] = useState<'consent' | 'sign' | 'done' | 'declined'>(
    props.consentAlreadyGiven ? 'sign' : 'consent',
  );
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [showDecline, setShowDecline] = useState(false);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-wide text-neutral-500">
          Signature requested
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{props.envelopeTitle}</h1>
        <p className="mt-1 text-sm text-neutral-700">
          From <span className="font-medium">{props.senderName}</span>
          {props.senderEmail && <> &lt;{props.senderEmail}&gt;</>}
        </p>
        {props.message && (
          <p className="mt-3 rounded-md bg-neutral-50 p-3 text-sm italic text-neutral-700">
            {props.message}
          </p>
        )}
      </header>

      <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-lg border border-neutral-200 bg-white p-2 shadow-sm">
          <DocumentView token={props.token} title={props.envelopeTitle} />
        </div>

        <aside className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
          {phase === 'consent' && (
            <ConsentStep token={props.token} onDone={() => setPhase('sign')} />
          )}
          {phase === 'sign' && (
            <SignStep
              token={props.token}
              fields={props.fields}
              recipient={props.recipient}
              onDone={(msg) => {
                setDoneMsg(msg);
                setPhase('done');
              }}
              onDeclineClick={() => setShowDecline(true)}
            />
          )}
          {phase === 'done' && (
            <div role="alert" className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-medium">{doneMsg ?? 'Signed.'}</p>
              <p className="mt-2">You may close this page.</p>
            </div>
          )}
          {phase === 'declined' && (
            <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-900">
              <p className="font-medium">{doneMsg ?? 'Declined.'}</p>
            </div>
          )}
        </aside>
      </section>

      {showDecline && phase !== 'done' && phase !== 'declined' && (
        <DeclineDialog
          token={props.token}
          onCancel={() => setShowDecline(false)}
          onDeclined={(msg) => {
            setDoneMsg(msg);
            setPhase('declined');
            setShowDecline(false);
          }}
        />
      )}
    </div>
  );
}

function ConsentStep({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, formAction] = useActionState(consentAction, initial);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <h2 className="text-base font-semibold">Before you sign</h2>
      <p className="text-sm text-neutral-700">
        By using DocuRidge to sign this document electronically you agree that:
      </p>
      <ul className="list-disc pl-5 text-sm text-neutral-700 space-y-1">
        <li>Your electronic signature is legally binding under UETA and the federal ESIGN Act.</li>
        <li>You may receive paper copies if you prefer; contact the sender to request them.</li>
        <li>You may withdraw consent for future documents at any time, which will end electronic delivery for those future documents only.</li>
        <li>You have the hardware and software to receive and review electronic records (a modern web browser is sufficient).</li>
      </ul>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.currentTarget.checked)}
          className="mt-1"
        />
        <span>I agree to use electronic records and signatures for this document.</span>
      </label>
      {state.error && <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{state.error}</div>}
      <ConsentSubmit disabled={!accepted} />
    </form>
  );
}

function ConsentSubmit({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex w-full items-center justify-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:opacity-50"
    >
      {pending ? 'Recording…' : 'I agree, continue'}
    </button>
  );
}

function SignStep(props: {
  token: string;
  fields: FieldDef[];
  recipient: { id: string; name: string; email: string };
  onDone: (msg: string) => void;
  onDeclineClick: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of props.fields) {
      if (f.defaultValue) init[f.id] = f.defaultValue;
      if (f.type === 'NAME') init[f.id] = props.recipient.name;
      if (f.type === 'EMAIL') init[f.id] = props.recipient.email;
      if (f.type === 'DATE') init[f.id] = new Date().toISOString().slice(0, 10);
    }
    return init;
  });
  const [signaturePng, setSignaturePng] = useState<string | null>(null);
  const [typedSignature, setTypedSignature] = useState('');
  const [showSigCanvas, setShowSigCanvas] = useState(false);
  const hasSignatureField = props.fields.some((f) => f.type === 'SIGNATURE' || f.type === 'INITIALS');
  const [state, formAction] = useActionState(submitSigningAction, initial);

  useEffect(() => {
    if (state.ok) props.onDone(state.message ?? 'Signed.');
  }, [state.ok, state.message, props]);

  const requiredMissing = props.fields.some((f) => {
    if (!f.required) return false;
    if (f.type === 'SIGNATURE' || f.type === 'INITIALS') return !signaturePng && !typedSignature;
    if (f.type === 'CHECKBOX') return values[f.id] !== 'true';
    return !values[f.id];
  });

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={props.token} />
      <input type="hidden" name="fieldValues" value={JSON.stringify(values)} />
      {signaturePng && <input type="hidden" name="signatureImagePngBase64" value={signaturePng} />}
      {typedSignature && <input type="hidden" name="typedSignature" value={typedSignature} />}

      <h2 className="text-base font-semibold">Complete the fields</h2>

      <ul className="space-y-3">
        {props.fields.map((f) => (
          <li key={f.id} className="rounded-md border border-neutral-200 p-3">
            <FieldInput
              field={f}
              value={values[f.id] ?? ''}
              onChange={(v) => setValues({ ...values, [f.id]: v })}
            />
          </li>
        ))}
      </ul>

      {hasSignatureField && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-neutral-700">Signature</p>
          {!showSigCanvas && (
            <button
              type="button"
              onClick={() => setShowSigCanvas(true)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100"
            >
              {signaturePng ? 'Redraw signature' : 'Draw signature'}
            </button>
          )}
          {showSigCanvas && (
            <SignaturePad
              onSave={(png) => {
                setSignaturePng(png);
                setShowSigCanvas(false);
              }}
              onCancel={() => setShowSigCanvas(false)}
            />
          )}
          <div className="text-xs text-neutral-500">— or —</div>
          <label className="block text-sm">
            <span className="block font-medium text-neutral-700">Type your signature</span>
            <input
              value={typedSignature}
              onChange={(e) => setTypedSignature(e.currentTarget.value)}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-serif italic"
              aria-label="Typed signature"
              placeholder="Your name"
            />
          </label>
          {signaturePng && <img src={signaturePng} alt="Signature preview" className="rounded border border-neutral-200 max-h-20" />}
        </div>
      )}

      {state.error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      <div className="flex flex-col gap-2 pt-2">
        <SignSubmitButton disabled={requiredMissing} />
        <button
          type="button"
          onClick={props.onDeclineClick}
          className="text-xs text-neutral-500 hover:underline self-center"
        >
          Decline to sign
        </button>
      </div>
    </form>
  );
}

function FieldInput(props: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const f = props.field;
  switch (f.type) {
    case 'TEXT':
    case 'NUMBER':
      return (
        <label className="block text-sm">
          <span className="block font-medium text-neutral-700">
            {labelFor(f)}{f.required && <span className="text-red-700"> *</span>}
          </span>
          <input
            type={f.type === 'NUMBER' ? 'number' : 'text'}
            value={props.value}
            onChange={(e) => props.onChange(e.currentTarget.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            required={f.required}
          />
        </label>
      );
    case 'DATE':
      return (
        <label className="block text-sm">
          <span className="block font-medium text-neutral-700">Date</span>
          <input
            type="date"
            value={props.value || new Date().toISOString().slice(0, 10)}
            onChange={(e) => props.onChange(e.currentTarget.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
        </label>
      );
    case 'CHECKBOX':
      return (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={props.value === 'true'}
            onChange={(e) => props.onChange(e.currentTarget.checked ? 'true' : '')}
            className="mt-1"
            required={f.required}
          />
          <span>I confirm{f.required ? ' (required)' : ''}</span>
        </label>
      );
    case 'NAME':
    case 'EMAIL':
      return (
        <p className="text-sm text-neutral-700">
          <span className="font-medium">{labelFor(f)}:</span> {props.value} <span className="text-xs text-neutral-500">(auto-filled)</span>
        </p>
      );
    case 'SIGNATURE':
    case 'INITIALS':
      return (
        <p className="text-sm text-neutral-700">
          <span className="font-medium">{labelFor(f)}:</span> sign below in the signature panel.
        </p>
      );
    default:
      return null;
  }
}

function labelFor(f: FieldDef): string {
  return ({
    SIGNATURE: 'Signature',
    INITIALS: 'Initials',
    DATE: 'Date',
    TEXT: 'Text',
    NUMBER: 'Number',
    CHECKBOX: 'Confirmation',
    NAME: 'Name',
    EMAIL: 'Email',
  } as Record<string, string>)[f.type] ?? f.type;
}

function SignSubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex w-full items-center justify-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:opacity-50"
    >
      {pending ? 'Signing…' : 'Confirm and sign'}
    </button>
  );
}

function SignaturePad({
  onSave,
  onCancel,
}: {
  onSave: (png: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    setDrawing(true);
    const c = canvasRef.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    const rect = c.getBoundingClientRect();
    const ctx = c.getContext('2d')!;
    ctx.beginPath();
    ctx.moveTo(((e.clientX - rect.left) / rect.width) * c.width, ((e.clientY - rect.top) / rect.height) * c.height);
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const ctx = c.getContext('2d')!;
    ctx.lineTo(((e.clientX - rect.left) / rect.width) * c.width, ((e.clientY - rect.top) / rect.height) * c.height);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
  }
  function onPointerUp() {
    setDrawing(false);
  }

  function clearCanvas() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
  }
  function save() {
    const c = canvasRef.current;
    if (!c) return;
    const data = c.toDataURL('image/png');
    onSave(data);
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={640}
        height={180}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="block w-full rounded-md border-2 border-neutral-400 bg-white"
        aria-label="Signature drawing area"
      />
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={clearCanvas} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100">
          Clear
        </button>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100">
            Cancel
          </button>
          <button type="button" onClick={save} className="rounded-md bg-accent-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-800">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function DeclineDialog({
  token,
  onCancel,
  onDeclined,
}: {
  token: string;
  onCancel: () => void;
  onDeclined: (msg: string) => void;
}) {
  const [state, formAction] = useActionState(declineAction, initial);
  useEffect(() => {
    if (state.ok) onDeclined(state.message ?? 'Declined.');
  }, [state.ok, state.message, onDeclined]);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/30 px-4 z-50" role="dialog" aria-modal="true" aria-labelledby="decline-title">
      <form action={formAction} className="rounded-lg bg-white p-5 shadow-lg max-w-md w-full space-y-3">
        <input type="hidden" name="token" value={token} />
        <h2 id="decline-title" className="text-base font-semibold">Decline to sign</h2>
        <p className="text-sm text-neutral-700">
          Tell the sender why. They&apos;ll be notified that you declined.
        </p>
        <label className="block text-sm">
          <span className="block font-medium text-neutral-700">Reason</span>
          <textarea
            name="reason"
            required
            rows={3}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
        </label>
        {state.error && (
          <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
            {state.error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100">
            Cancel
          </button>
          <DeclineSubmit />
        </div>
      </form>
    </div>
  );
}

function DeclineSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50">
      {pending ? 'Declining…' : 'Decline'}
    </button>
  );
}
