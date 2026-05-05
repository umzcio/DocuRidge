'use client';

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ChangeEvent,
} from 'react';
import { useFormStatus } from 'react-dom';
import { createAndSendEnvelopeAction, type CreateEnvelopeState } from './actions';

// ─── Field model ─────────────────────────────────────────────────────────
type FieldType = 'SIGNATURE' | 'INITIALS' | 'DATE' | 'TEXT' | 'CHECKBOX' | 'NAME' | 'EMAIL';

interface FieldDefaults {
  w: number;
  h: number;
  label: string;
}

const FIELD_DEFAULTS: Record<FieldType, FieldDefaults> = {
  SIGNATURE: { w: 0.30, h: 0.06, label: 'Signature' },
  INITIALS:  { w: 0.10, h: 0.05, label: 'Initials' },
  DATE:      { w: 0.16, h: 0.035, label: 'Date' },
  TEXT:      { w: 0.25, h: 0.035, label: 'Text' },
  CHECKBOX:  { w: 0.04, h: 0.04, label: 'Checkbox' },
  NAME:      { w: 0.25, h: 0.035, label: 'Auto: Name' },
  EMAIL:     { w: 0.30, h: 0.035, label: 'Auto: Email' },
};

interface DocumentDef {
  clientId: string;
  file: File;
  name: string;
  pageCount: number;
}

interface RecipientDef {
  clientId: string;
  name: string;
  email: string;
}

interface FieldDef {
  id: string;
  documentClientId: string;
  recipientClientId: string;
  page: number;          // 1-indexed
  type: FieldType;
  x: number; y: number; w: number; h: number;
  required: boolean;
}

// Distinct, accessible-contrast colors per recipient slot. Cycles after 6.
const RECIPIENT_COLORS = [
  { fg: 'rgb(30,64,175)',  bg: 'rgba(59,130,246,0.18)', name: 'blue' },    // 1st
  { fg: 'rgb(146,64,14)',  bg: 'rgba(245,158,11,0.18)', name: 'amber' },   // 2nd
  { fg: 'rgb(6,95,70)',    bg: 'rgba(16,185,129,0.18)', name: 'emerald' }, // 3rd
  { fg: 'rgb(159,18,57)',  bg: 'rgba(244,63,94,0.18)',  name: 'rose' },    // 4th
  { fg: 'rgb(91,33,182)',  bg: 'rgba(139,92,246,0.18)', name: 'violet' },  // 5th
  { fg: 'rgb(120,53,15)',  bg: 'rgba(217,119,6,0.18)',  name: 'orange' },  // 6th
];

function colorForRecipient(idx: number) {
  return RECIPIENT_COLORS[idx % RECIPIENT_COLORS.length]!;
}

const initialState: CreateEnvelopeState = { ok: false };

export function NewEnvelopeForm() {
  const [state, formAction] = useActionState(createAndSendEnvelopeAction, initialState);
  const [documents, setDocuments] = useState<DocumentDef[]>([]);
  const [recipients, setRecipients] = useState<RecipientDef[]>(() => [
    { clientId: crypto.randomUUID(), name: '', email: '' },
  ]);
  const [activeRecipientId, setActiveRecipientId] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [armedType, setArmedType] = useState<FieldType | null>(null);
  const [routingMode, setRoutingMode] = useState<'SEQUENTIAL' | 'PARALLEL'>('SEQUENTIAL');

  // Keep activeRecipientId valid when recipients change.
  useEffect(() => {
    if (recipients.length === 0) {
      setActiveRecipientId(null);
      return;
    }
    if (!activeRecipientId || !recipients.some((r) => r.clientId === activeRecipientId)) {
      setActiveRecipientId(recipients[0]!.clientId);
    }
  }, [recipients, activeRecipientId]);

  async function onFilesChosen(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.currentTarget.files ?? []);
    if (!files.length) return;
    e.currentTarget.value = '';
    const pdfjs = await loadPdfjs();
    const newDocs: DocumentDef[] = [];
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const doc = await pdfjs.getDocument({ data: buf }).promise;
        newDocs.push({ clientId: crypto.randomUUID(), file: f, name: f.name, pageCount: doc.numPages });
      } catch {
        newDocs.push({ clientId: crypto.randomUUID(), file: f, name: f.name, pageCount: 1 });
      }
    }
    setDocuments((cur) => [...cur, ...newDocs]);
  }

  function removeDocument(clientId: string) {
    setDocuments((cur) => cur.filter((d) => d.clientId !== clientId));
    setFields((cur) => cur.filter((f) => f.documentClientId !== clientId));
  }

  function placeField(args: {
    documentClientId: string;
    page: number;
    type: FieldType;
    x: number;
    y: number;
  }) {
    if (!activeRecipientId) return;
    const def = FIELD_DEFAULTS[args.type];
    const x = clamp01(args.x - def.w / 2);
    const y = clamp01(args.y - def.h / 2);
    const w = Math.min(def.w, 1 - x);
    const h = Math.min(def.h, 1 - y);
    setFields((cur) => [
      ...cur,
      {
        id: crypto.randomUUID(),
        documentClientId: args.documentClientId,
        recipientClientId: activeRecipientId,
        page: args.page,
        type: args.type,
        x, y, w, h,
        required: true,
      },
    ]);
  }

  function moveField(id: string, x: number, y: number) {
    setFields((cur) => cur.map((f) => (f.id === id ? { ...f, x: clamp01(x), y: clamp01(y) } : f)));
  }
  function removeField(id: string) {
    setFields((cur) => cur.filter((f) => f.id !== id));
  }
  function toggleRequired(id: string) {
    setFields((cur) => cur.map((f) => (f.id === id ? { ...f, required: !f.required } : f)));
  }
  function reassignField(id: string, recipientClientId: string) {
    setFields((cur) => cur.map((f) => (f.id === id ? { ...f, recipientClientId } : f)));
  }

  function addRecipient() {
    setRecipients((cur) => [...cur, { clientId: crypto.randomUUID(), name: '', email: '' }]);
  }
  function removeRecipient(clientId: string) {
    if (recipients.length === 1) return;
    setRecipients((cur) => cur.filter((r) => r.clientId !== clientId));
    setFields((cur) => cur.filter((f) => f.recipientClientId !== clientId));
  }
  function updateRecipient(clientId: string, patch: Partial<Omit<RecipientDef, 'clientId'>>) {
    setRecipients((cur) => cur.map((r) => (r.clientId === clientId ? { ...r, ...patch } : r)));
  }

  const recipientIndex = (cid: string) => recipients.findIndex((r) => r.clientId === cid);

  return (
    <form
      action={formAction}
      className="space-y-6"
      onSubmit={(e) => {
        if (documents.length === 0 || fields.length === 0 || recipients.length === 0) {
          e.preventDefault();
          alert('Add a document, at least one recipient, and at least one field before sending.');
          return;
        }
      }}
      noValidate
    >
      <Section title="Document(s)">
        <Field label="Title" name="title" required error={state.fieldErrors?.title} />
        <Field label="Optional note to recipients" name="message" textarea />
        <label className="block">
          <span className="block text-sm font-medium text-neutral-700">Add PDF(s)</span>
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={onFilesChosen}
            className="mt-1 block w-full text-sm"
            aria-label="Add PDF documents to this envelope"
          />
          <span className="mt-1 block text-xs text-neutral-500">PDFs only. Up to 25MB each.</span>
        </label>
        <DocumentRefs documents={documents} />
        {documents.length > 0 && (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {documents.map((d, idx) => (
              <li key={d.clientId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-neutral-700">
                  #{idx + 1} · {d.name} · {d.pageCount} page{d.pageCount === 1 ? '' : 's'}
                </span>
                <button type="button" onClick={() => removeDocument(d.clientId)} className="text-xs text-red-700 hover:underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recipients">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium text-neutral-700">Routing:</span>
          <label className="inline-flex items-center gap-1">
            <input type="radio" checked={routingMode === 'SEQUENTIAL'} onChange={() => setRoutingMode('SEQUENTIAL')} />
            Sequential
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="radio" checked={routingMode === 'PARALLEL'} onChange={() => setRoutingMode('PARALLEL')} />
            Parallel
          </label>
        </div>
        <p className="text-xs text-neutral-500">
          Sequential: each recipient signs in order. Parallel: every recipient is invited at the same time.
        </p>

        <ul className="space-y-2">
          {recipients.map((r, idx) => {
            const color = colorForRecipient(idx);
            return (
              <li key={r.clientId} className="rounded-md border border-neutral-200 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold"
                    style={{ background: color.bg, color: color.fg }}
                    aria-label={`Recipient ${idx + 1}`}
                  >
                    {idx + 1}
                  </span>
                  <span className="text-xs uppercase tracking-wide text-neutral-500">
                    {routingMode === 'SEQUENTIAL' ? `Signs ${ordinal(idx + 1)}` : 'Signs in parallel'}
                  </span>
                  <div className="ml-auto flex gap-2">
                    {recipients.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRecipient(r.clientId)}
                        className="text-xs text-red-700 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block text-sm">
                    <span className="block font-medium text-neutral-700">Name</span>
                    <input
                      value={r.name}
                      onChange={(e) => updateRecipient(r.clientId, { name: e.currentTarget.value })}
                      required
                      className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="block font-medium text-neutral-700">Email</span>
                    <input
                      type="email"
                      value={r.email}
                      onChange={(e) => updateRecipient(r.clientId, { email: e.currentTarget.value })}
                      required
                      className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={addRecipient}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100"
        >
          + Add recipient
        </button>
      </Section>

      {documents.length > 0 && recipients.length > 0 && (
        <Section title="Place fields">
          <p className="text-sm text-neutral-700">
            Pick a recipient to assign new fields to, then drag a field type onto a page (or click a tile and click on a page).
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-6 mt-3">
            <DocumentsCanvas
              documents={documents}
              fields={fields}
              recipients={recipients}
              armedType={armedType}
              activeRecipientId={activeRecipientId}
              onPlace={(args) => {
                placeField(args);
                setArmedType(null);
              }}
              onMove={moveField}
              onRemove={removeField}
              onToggleRequired={toggleRequired}
              onReassign={reassignField}
            />
            <FieldTileTray
              recipients={recipients}
              activeRecipientId={activeRecipientId}
              onPickRecipient={setActiveRecipientId}
              armedType={armedType}
              onArm={setArmedType}
            />
          </div>

          <input
            type="hidden"
            name="documents"
            value={JSON.stringify(
              documents.map((d, i) => ({
                clientId: d.clientId,
                filename: d.name,
                pageCount: d.pageCount,
                order: i + 1,
              })),
            )}
          />
          <input
            type="hidden"
            name="recipients"
            value={JSON.stringify(
              recipients.map((r, i) => ({
                clientId: r.clientId,
                name: r.name,
                email: r.email,
                signingOrder: i + 1,
              })),
            )}
          />
          <input type="hidden" name="fields" value={JSON.stringify(fields)} />
          <input type="hidden" name="routingMode" value={routingMode} />

          {fields.length > 0 && (
            <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200 text-sm">
              {fields.map((f, i) => {
                const doc = documents.find((d) => d.clientId === f.documentClientId);
                const rIdx = recipientIndex(f.recipientClientId);
                const color = rIdx >= 0 ? colorForRecipient(rIdx) : null;
                return (
                  <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="font-mono text-xs flex items-center gap-2">
                      {color && (
                        <span
                          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold"
                          style={{ background: color.bg, color: color.fg }}
                          aria-label={`Recipient ${rIdx + 1}`}
                        >
                          {rIdx + 1}
                        </span>
                      )}
                      #{i + 1} {f.type} · {doc?.name ?? '?'} p{f.page} · ({f.x.toFixed(2)}, {f.y.toFixed(2)})
                      {!f.required && <span className="ml-1 text-neutral-500">(optional)</span>}
                    </span>
                    <div className="flex items-center gap-2">
                      <select
                        value={f.recipientClientId}
                        onChange={(e) => reassignField(f.id, e.currentTarget.value)}
                        className="text-xs rounded border border-neutral-300 px-1 py-0.5"
                        aria-label="Reassign field to recipient"
                      >
                        {recipients.map((r, idx) => (
                          <option key={r.clientId} value={r.clientId}>
                            #{idx + 1} {r.name || r.email || '(unnamed)'}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="text-xs text-neutral-600 hover:underline" onClick={() => toggleRequired(f.id)}>
                        {f.required ? 'Mark optional' : 'Mark required'}
                      </button>
                      <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => removeField(f.id)}>
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {state.error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      <div className="flex justify-end">
        <SubmitButton disabled={documents.length === 0 || fields.length === 0 || recipients.length === 0} />
      </div>
    </form>
  );
}

// ─── Document refs ───────────────────────────────────────────────────────
function DocumentRefs({ documents }: { documents: DocumentDef[] }) {
  return <>{documents.map((d) => <DocumentRef key={d.clientId} doc={d} />)}</>;
}

function DocumentRef({ doc }: { doc: DocumentDef }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(doc.file);
      el.files = dt.files;
    } catch {
      // ignore — server-side validation will catch missing files
    }
  }, [doc.file]);
  return (
    <input ref={ref} type="file" name="document" data-client-id={doc.clientId} className="hidden" tabIndex={-1} aria-hidden="true" />
  );
}

// ─── Document canvas ─────────────────────────────────────────────────────
function DocumentsCanvas(props: {
  documents: DocumentDef[];
  fields: FieldDef[];
  recipients: RecipientDef[];
  armedType: FieldType | null;
  activeRecipientId: string | null;
  onPlace: (args: { documentClientId: string; page: number; type: FieldType; x: number; y: number }) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRemove: (id: string) => void;
  onToggleRequired: (id: string) => void;
  onReassign: (id: string, recipientClientId: string) => void;
}) {
  return (
    <div className="space-y-6">
      {props.documents.map((doc) => (
        <DocumentBlock
          key={doc.clientId}
          doc={doc}
          fields={props.fields.filter((f) => f.documentClientId === doc.clientId)}
          recipients={props.recipients}
          armedType={props.armedType}
          activeRecipientId={props.activeRecipientId}
          onPlace={(page, type, x, y) =>
            props.onPlace({ documentClientId: doc.clientId, page, type, x, y })
          }
          onMove={props.onMove}
          onRemove={props.onRemove}
          onToggleRequired={props.onToggleRequired}
          onReassign={props.onReassign}
        />
      ))}
    </div>
  );
}

function DocumentBlock(props: {
  doc: DocumentDef;
  fields: FieldDef[];
  recipients: RecipientDef[];
  armedType: FieldType | null;
  activeRecipientId: string | null;
  onPlace: (page: number, type: FieldType, x: number, y: number) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRemove: (id: string) => void;
  onToggleRequired: (id: string) => void;
  onReassign: (id: string, recipientClientId: string) => void;
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <div className="text-xs font-medium text-neutral-700 mb-2">{props.doc.name}</div>
      <div className="space-y-3">
        {Array.from({ length: props.doc.pageCount }, (_, i) => i + 1).map((page) => (
          <PageDropTarget
            key={page}
            doc={props.doc}
            page={page}
            fields={props.fields.filter((f) => f.page === page)}
            recipients={props.recipients}
            armedType={props.armedType}
            activeRecipientId={props.activeRecipientId}
            onPlace={(t, x, y) => props.onPlace(page, t, x, y)}
            onMove={props.onMove}
            onRemove={props.onRemove}
            onToggleRequired={props.onToggleRequired}
            onReassign={props.onReassign}
          />
        ))}
      </div>
    </div>
  );
}

function PageDropTarget(props: {
  doc: DocumentDef;
  page: number;
  fields: FieldDef[];
  recipients: RecipientDef[];
  armedType: FieldType | null;
  activeRecipientId: string | null;
  onPlace: (t: FieldType, x: number, y: number) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRemove: (id: string) => void;
  onToggleRequired: (id: string) => void;
  onReassign: (id: string, recipientClientId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdfjs = await loadPdfjs();
      const buf = await props.doc.file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      if (cancelled) return;
      const page = await pdf.getPage(props.page);
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = wrapRef.current?.clientWidth ?? 800;
      const scale = Math.min(2, targetWidth / baseViewport.width);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (!cancelled) setDimensions({ w: viewport.width, h: viewport.height });
    })().catch(() => {
      if (!cancelled) setDimensions({ w: 800, h: 1000 });
    });
    return () => { cancelled = true; };
  }, [props.doc.file, props.page]);

  function fractionalFromEvent(e: { clientX: number; clientY: number }) {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0.5, y: 0.5 };
    const rect = wrap.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer.types.includes('text/x-docuridge-field')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/x-docuridge-field');
    if (!data) return;
    const moveId = e.dataTransfer.getData('text/x-docuridge-move');
    const { x, y } = fractionalFromEvent(e);
    if (moveId) {
      props.onMove(moveId, x, y);
    } else {
      props.onPlace(data as FieldType, x, y);
    }
  }
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!props.armedType) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-placed-field]')) return;
    const { x, y } = fractionalFromEvent(e);
    props.onPlace(props.armedType, x, y);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!props.armedType) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      props.onPlace(props.armedType, 0.5, 0.5);
    }
  }

  const armed = props.armedType !== null && props.activeRecipientId !== null;

  return (
    <div className="relative inline-block w-full" data-testid={`page-${props.doc.clientId}-${props.page}`}>
      <div className="text-xs text-neutral-500 mb-1">Page {props.page}</div>
      <div
        ref={wrapRef}
        data-loaded={dimensions ? 'true' : 'false'}
        data-page-target=""
        data-armed-type={props.armedType ?? ''}
        data-active-recipient={props.activeRecipientId ?? ''}
        style={dimensions ? { aspectRatio: `${dimensions.w}/${dimensions.h}` } : undefined}
        className={`relative w-full overflow-hidden rounded border ${armed ? 'border-accent-500 cursor-crosshair' : 'border-neutral-300'} bg-neutral-50`}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={onClick}
        onKeyDown={onKeyDown}
        tabIndex={armed ? 0 : -1}
        role={armed ? 'button' : undefined}
        aria-label={armed ? `Click to place ${props.armedType} field on page ${props.page}` : undefined}
      >
        <canvas ref={canvasRef} className="block w-full h-auto pointer-events-none" aria-label={`Document page ${props.page}`} />
        {dimensions && props.fields.map((f) => {
          const recipientIdx = props.recipients.findIndex((r) => r.clientId === f.recipientClientId);
          const color = recipientIdx >= 0 ? colorForRecipient(recipientIdx) : null;
          return (
            <PlacedFieldMark
              key={f.id}
              field={f}
              recipientIndex={recipientIdx}
              color={color}
              onMove={(x, y) => props.onMove(f.id, x, y)}
              onRemove={() => props.onRemove(f.id)}
              onToggleRequired={() => props.onToggleRequired(f.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function PlacedFieldMark(props: {
  field: FieldDef;
  recipientIndex: number;
  color: { fg: string; bg: string } | null;
  onMove: (x: number, y: number) => void;
  onRemove: () => void;
  onToggleRequired: () => void;
}) {
  const f = props.field;
  function onDragStart(e: DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData('text/x-docuridge-field', f.type);
    e.dataTransfer.setData('text/x-docuridge-move', f.id);
    e.dataTransfer.effectAllowed = 'move';
  }
  const c = props.color ?? { fg: 'rgb(38,85,88)', bg: 'rgba(61,133,133,0.18)' };
  return (
    <div
      draggable
      onDragStart={onDragStart}
      data-placed-field={f.id}
      style={{
        position: 'absolute',
        left: `${f.x * 100}%`,
        top: `${f.y * 100}%`,
        width: `${f.w * 100}%`,
        height: `${f.h * 100}%`,
        background: c.bg,
        border: `2px solid ${c.fg}`,
        borderStyle: f.required ? 'solid' : 'dashed',
      }}
      className="group rounded cursor-move flex items-center justify-center text-[10px] font-medium"
      role="group"
      aria-label={`Placed ${FIELD_DEFAULTS[f.type].label} field for recipient ${props.recipientIndex + 1}, ${f.required ? 'required' : 'optional'}`}
    >
      <span className="px-1 truncate" style={{ color: c.fg }}>
        #{props.recipientIndex + 1} {FIELD_DEFAULTS[f.type].label}
      </span>
      <div className="absolute -top-6 right-0 hidden group-hover:flex gap-1 bg-white border border-neutral-300 rounded px-1 py-0.5 text-[10px] shadow">
        <button type="button" onClick={props.onToggleRequired} className="text-neutral-700 hover:underline">
          {f.required ? '✓ req' : '○ opt'}
        </button>
        <button type="button" onClick={props.onRemove} className="text-red-700 hover:underline">
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Field tray ──────────────────────────────────────────────────────────
function FieldTileTray(props: {
  recipients: RecipientDef[];
  activeRecipientId: string | null;
  onPickRecipient: (id: string) => void;
  armedType: FieldType | null;
  onArm: (t: FieldType | null) => void;
}) {
  const types = Object.keys(FIELD_DEFAULTS) as FieldType[];
  const activeIdx = props.recipients.findIndex((r) => r.clientId === props.activeRecipientId);
  const activeColor = activeIdx >= 0 ? colorForRecipient(activeIdx) : null;
  return (
    <aside className="rounded-md border border-neutral-200 bg-white p-3 space-y-3 lg:sticky lg:top-3 self-start">
      <div>
        <h3 className="text-sm font-semibold">Assigning fields to</h3>
        <p className="text-xs text-neutral-500">Click to switch recipients.</p>
        <ul className="mt-2 space-y-1">
          {props.recipients.map((r, idx) => {
            const c = colorForRecipient(idx);
            const active = props.activeRecipientId === r.clientId;
            return (
              <li key={r.clientId}>
                <button
                  type="button"
                  onClick={() => props.onPickRecipient(r.clientId)}
                  className={`w-full text-left rounded-md border px-2 py-1 text-xs flex items-center gap-2 ${active ? 'border-accent-700 ring-2 ring-accent-500' : 'border-neutral-300 hover:bg-neutral-100'}`}
                  aria-pressed={active}
                >
                  <span
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold"
                    style={{ background: c.bg, color: c.fg }}
                    aria-hidden="true"
                  >
                    {idx + 1}
                  </span>
                  <span className="truncate">{r.name || r.email || `Recipient ${idx + 1}`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-semibold">Field types</h3>
        <p className="text-xs text-neutral-500">Drag onto a page, or click then click on a page.</p>
        <ul className="mt-2 space-y-1">
          {types.map((t) => (
            <li key={t}>
              <FieldTile
                type={t}
                armed={props.armedType === t}
                colorFg={activeColor?.fg}
                onArm={() => props.onArm(props.armedType === t ? null : t)}
              />
            </li>
          ))}
        </ul>
      </div>
      {props.armedType && (
        <button type="button" onClick={() => props.onArm(null)} className="text-xs text-neutral-500 hover:underline">
          Cancel placement
        </button>
      )}
    </aside>
  );
}

function FieldTile({
  type,
  armed,
  colorFg,
  onArm,
}: {
  type: FieldType;
  armed: boolean;
  colorFg?: string;
  onArm: () => void;
}) {
  function onDragStart(e: DragEvent<HTMLButtonElement>) {
    e.dataTransfer.setData('text/x-docuridge-field', type);
    e.dataTransfer.effectAllowed = 'copy';
  }
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onArm}
      aria-pressed={armed}
      className={`w-full text-left rounded-md border px-3 py-1.5 text-sm font-medium cursor-grab active:cursor-grabbing ${armed ? 'border-accent-700 bg-accent-100 text-accent-900 ring-2 ring-accent-500' : 'border-neutral-300 bg-neutral-50 hover:bg-neutral-100'}`}
      style={armed && colorFg ? { borderColor: colorFg } : undefined}
      aria-label={`Place a ${FIELD_DEFAULTS[type].label} field`}
    >
      {FIELD_DEFAULTS[type].label}
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function clamp01(v: number) {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

let _pdfjs: typeof import('pdfjs-dist') | null = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const mod = await import('pdfjs-dist');
  mod.GlobalWorkerOptions.workerSrc = '/DocuRidge/pdf.worker.mjs';
  _pdfjs = mod;
  return mod;
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
  const id = useId();
  return (
    <label className="block" htmlFor={id}>
      <span className="block text-sm font-medium text-neutral-700">{props.label}</span>
      {props.textarea ? (
        <textarea
          id={id}
          name={props.name}
          rows={3}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      ) : (
        <input
          id={id}
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
