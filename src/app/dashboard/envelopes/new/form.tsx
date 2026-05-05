'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { createAndSendEnvelopeAction, type CreateEnvelopeState } from './actions';

interface FieldDef {
  id: string;
  type: 'SIGNATURE' | 'INITIALS' | 'DATE' | 'TEXT' | 'CHECKBOX' | 'NAME' | 'EMAIL';
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
}

const initialState: CreateEnvelopeState = { ok: false };

export function NewEnvelopeForm() {
  const [state, formAction] = useActionState(createAndSendEnvelopeAction, initialState);
  const [pageCount, setPageCount] = useState(1);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Defaults for the next field added.
  const [draftField, setDraftField] = useState<Omit<FieldDef, 'id'>>({
    type: 'SIGNATURE',
    page: 1,
    x: 0.55,
    y: 0.85,
    w: 0.3,
    h: 0.06,
    required: true,
  });

  function addField() {
    setFields((cur) => [
      ...cur,
      { id: crypto.randomUUID(), ...draftField },
    ]);
  }
  function removeField(id: string) {
    setFields((cur) => cur.filter((f) => f.id !== id));
  }

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {/* Document title + message */}
      <Section title="Document">
        <Field label="Title" name="title" required error={state.fieldErrors?.title} />
        <Field label="Optional sender note" name="message" textarea />

        <label className="block">
          <span className="block text-sm font-medium text-neutral-700">PDF file</span>
          <input
            ref={fileRef}
            name="document"
            type="file"
            accept="application/pdf"
            required
            className="mt-1 block w-full text-sm"
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              if (!f) return;
              try {
                const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
                pdfjs.GlobalWorkerOptions.workerSrc = '/DocuRidge/_next/static/chunks/pdf.worker.mjs';
                const buf = await f.arrayBuffer();
                const doc = await pdfjs.getDocument({ data: buf }).promise;
                setPageCount(doc.numPages);
              } catch {
                // Fallback: leave at 1; pageCount input is editable.
              }
            }}
          />
          <p className="mt-1 text-xs text-neutral-500">PDFs only. Max 25MB.</p>
        </label>
      </Section>

      {/* Recipient */}
      <Section title="Recipient">
        <Field label="Name" name="recipientName" required error={state.fieldErrors?.recipientName} />
        <Field label="Email" name="recipientEmail" type="email" required error={state.fieldErrors?.recipientEmail} />
      </Section>

      {/* Page count */}
      <Section title="Pages">
        <label className="block">
          <span className="block text-sm font-medium text-neutral-700">Number of pages</span>
          <input
            name="pageCount"
            type="number"
            min={1}
            max={2000}
            value={pageCount}
            onChange={(e) => setPageCount(parseInt(e.target.value || '1', 10) || 1)}
            className="mt-1 block w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Auto-detected when you upload the PDF. Edit if it&apos;s wrong.
          </p>
        </label>
      </Section>

      {/* Fields */}
      <Section title="Fields">
        <p className="text-sm text-neutral-600">
          Add fields the recipient must complete. Coordinates are fractions (0&ndash;1) of the page width and height,
          measured from the top-left.
        </p>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-7 items-end mt-2">
          <label className="col-span-2 md:col-span-2 text-sm">
            <span className="text-neutral-700 font-medium">Type</span>
            <select
              value={draftField.type}
              onChange={(e) => setDraftField({ ...draftField, type: e.target.value as FieldDef['type'] })}
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            >
              <option value="SIGNATURE">Signature</option>
              <option value="INITIALS">Initials</option>
              <option value="DATE">Date</option>
              <option value="TEXT">Text</option>
              <option value="CHECKBOX">Checkbox</option>
              <option value="NAME">Auto-fill: Name</option>
              <option value="EMAIL">Auto-fill: Email</option>
            </select>
          </label>
          <NumField label="Page" value={draftField.page} step={1}
            onChange={(v) => setDraftField({ ...draftField, page: Math.max(1, Math.min(pageCount, v | 0)) })} />
          <NumField label="x" value={draftField.x} step={0.01}
            onChange={(v) => setDraftField({ ...draftField, x: clamp01(v) })} />
          <NumField label="y" value={draftField.y} step={0.01}
            onChange={(v) => setDraftField({ ...draftField, y: clamp01(v) })} />
          <NumField label="w" value={draftField.w} step={0.01}
            onChange={(v) => setDraftField({ ...draftField, w: clamp01(v) })} />
          <NumField label="h" value={draftField.h} step={0.01}
            onChange={(v) => setDraftField({ ...draftField, h: clamp01(v) })} />
        </div>

        <div className="mt-3">
          <button
            type="button"
            onClick={addField}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100"
          >
            + Add field
          </button>
        </div>

        {fields.length > 0 && (
          <ul className="mt-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {fields.map((f, i) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-neutral-700">
                  #{i + 1} {f.type} · page {f.page} · ({f.x.toFixed(2)}, {f.y.toFixed(2)}) {f.w.toFixed(2)}×{f.h.toFixed(2)}
                </span>
                <button type="button" onClick={() => removeField(f.id)} className="text-xs text-red-700 hover:underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <input type="hidden" name="fields" value={JSON.stringify(fields)} />

        {fields.length === 0 && (
          <p className="mt-3 text-sm text-amber-700">
            Add at least one field (a SIGNATURE field is recommended) before sending.
          </p>
        )}
      </Section>

      {state.error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
      )}
      <div className="flex justify-end gap-3">
        <SubmitButton disabled={fields.length === 0} />
      </div>
    </form>
  );
}

function clamp01(v: number) {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-neutral-800">{title}</legend>
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

function Field(props: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  textarea?: boolean;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-neutral-700">{props.label}</span>
      {props.textarea ? (
        <textarea
          name={props.name}
          rows={3}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      ) : (
        <input
          name={props.name}
          type={props.type ?? 'text'}
          required={props.required}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
          aria-invalid={props.error ? 'true' : 'false'}
        />
      )}
      {props.error && <p className="mt-1 text-sm text-red-700">{props.error}</p>}
    </label>
  );
}

function NumField(props: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="text-sm">
      <span className="text-neutral-700 font-medium">{props.label}</span>
      <input
        type="number"
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex items-center justify-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:opacity-50"
    >
      {pending ? 'Creating envelope…' : 'Create & send envelope'}
    </button>
  );
}
