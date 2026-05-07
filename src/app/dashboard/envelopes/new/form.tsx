'use client';

import {
  useActionState,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ChangeEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useFormStatus } from 'react-dom';
import { createAndSendEnvelopeAction, type CreateEnvelopeState } from './actions';
import { Select } from '@/components/ui/select';
import { useEscape } from '@/lib/use-escape';

type FieldType =
  | 'SIGNATURE' | 'INITIALS' | 'DATE' | 'TEXT' | 'NUMBER' | 'CHECKBOX'
  | 'NAME' | 'EMAIL' | 'JOB_TITLE' | 'PHONE' | 'ADDRESS' | 'COMPANY'
  | 'DROPDOWN' | 'RADIO' | 'FORMULA' | 'ATTACHMENT'
  | 'APPROVE' | 'DECLINE' | 'NOTE' | 'LINE' | 'STAMP' | 'DRAWING';

interface FieldDefaults { w: number; h: number; label: string }

const FIELD_DEFAULTS: Record<FieldType, FieldDefaults> = {
  SIGNATURE:  { w: 0.30, h: 0.06,  label: 'Signature' },
  INITIALS:   { w: 0.10, h: 0.05,  label: 'Initials' },
  DATE:       { w: 0.16, h: 0.035, label: 'Date' },
  TEXT:       { w: 0.25, h: 0.035, label: 'Text' },
  NUMBER:     { w: 0.16, h: 0.035, label: 'Number' },
  CHECKBOX:   { w: 0.04, h: 0.04,  label: 'Checkbox' },
  NAME:       { w: 0.25, h: 0.035, label: 'Name' },
  EMAIL:      { w: 0.30, h: 0.035, label: 'Email' },
  JOB_TITLE:  { w: 0.25, h: 0.035, label: 'Job title' },
  PHONE:      { w: 0.20, h: 0.035, label: 'Phone' },
  ADDRESS:    { w: 0.35, h: 0.05,  label: 'Address' },
  COMPANY:    { w: 0.25, h: 0.035, label: 'Company' },
  DROPDOWN:   { w: 0.25, h: 0.035, label: 'Dropdown' },
  RADIO:      { w: 0.25, h: 0.06,  label: 'Radio' },
  FORMULA:    { w: 0.20, h: 0.035, label: 'Formula' },
  ATTACHMENT: { w: 0.30, h: 0.05,  label: 'Attachment' },
  APPROVE:    { w: 0.20, h: 0.045, label: 'Approve' },
  DECLINE:    { w: 0.20, h: 0.045, label: 'Decline' },
  NOTE:       { w: 0.30, h: 0.04,  label: 'Note' },
  LINE:       { w: 0.25, h: 0.012, label: 'Line' },
  STAMP:      { w: 0.20, h: 0.10,  label: 'Stamp' },
  DRAWING:    { w: 0.30, h: 0.10,  label: 'Drawing' },
};

interface DocumentDef { clientId: string; file: File; name: string; pageCount: number }
interface RecipientDef {
  clientId: string;
  name: string;
  email: string;
  role: 'SIGNER' | 'CC' | 'APPROVER' | 'WITNESS' | 'IN_PERSON_SIGNER';
  /**
   * Optional conditional-routing rule. The recipient is routed to only when
   * the field referenced by `whenFieldId` (an *earlier* recipient's field)
   * has a value matching `equals`. Otherwise they are skipped.
   */
  condition?: { whenFieldId: string; equals: string };
}
interface FieldDef {
  id: string;
  documentClientId: string;
  recipientClientId: string;
  page: number;
  type: FieldType;
  x: number; y: number; w: number; h: number;
  required: boolean;
  defaultValue?: string;
  readOnly?: boolean;
  charLimit?: number;
  pattern?: string;
  patternMessage?: string;
  min?: number;
  max?: number;
  dataLabel?: string;
  options?: string[];
  /** FORMULA: expression evaluated against other fields' values, e.g. "{a} * 0.07". */
  formula?: string;
  /** NOTE: sender-authored static text rendered on the document. */
  noteText?: string;
  /** STAMP: sender-uploaded image (base64-encoded, no data: prefix). */
  stampImageBase64?: string;
  /** STAMP: MIME type of the uploaded image (image/png or image/jpeg). */
  stampMimeType?: string;
  /**
   * Show this field only when the value of `whenFieldId` equals `equals`.
   * For CHECKBOX sources, `equals` is the literal "true" / "false". For
   * DROPDOWN / RADIO sources, `equals` is one of the source's options.
   * When the condition is unmet, the field is hidden from the recipient
   * (no checklist row, no overlay) and skipped by the required-check.
   */
  condition?: { whenFieldId: string; equals: string };
}

const RECIPIENT_COLORS = [
  { fg: '#1E40AF', bg: 'rgba(59,130,246,0.18)', solid: 'rgba(59,130,246,0.45)', name: 'blue' },
  { fg: '#92400E', bg: 'rgba(245,158,11,0.18)', solid: 'rgba(245,158,11,0.45)', name: 'amber' },
  { fg: '#065F46', bg: 'rgba(16,185,129,0.18)', solid: 'rgba(16,185,129,0.45)', name: 'emerald' },
  { fg: '#9F1239', bg: 'rgba(244,63,94,0.18)',  solid: 'rgba(244,63,94,0.45)',  name: 'rose' },
  { fg: '#5B21B6', bg: 'rgba(139,92,246,0.18)', solid: 'rgba(139,92,246,0.45)', name: 'violet' },
  { fg: '#78350F', bg: 'rgba(217,119,6,0.18)',  solid: 'rgba(217,119,6,0.45)',  name: 'orange' },
];
const colorForRecipient = (idx: number) => RECIPIENT_COLORS[idx % RECIPIENT_COLORS.length]!;

const initialState: CreateEnvelopeState = { ok: false };

export function NewEnvelopeForm() {
  const [state, formAction] = useActionState(createAndSendEnvelopeAction, initialState);
  const [phase, setPhase] = useState<'start' | 'prepare'>('start');

  // Document + meta state
  const [documents, setDocuments] = useState<DocumentDef[]>([]);
  const [title, setTitle] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [message, setMessage] = useState('');

  // Builder state
  const [recipients, setRecipients] = useState<RecipientDef[]>([]);
  const [activeRecipientId, setActiveRecipientId] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [armedType, setArmedType] = useState<FieldType | null>(null);
  const [routingMode, setRoutingMode] = useState<'SEQUENTIAL' | 'PARALLEL'>('SEQUENTIAL');
  const [autoReminders, setAutoReminders] = useState(true);
  const [expiresIn, setExpiresIn] = useState<'7' | '14' | '30' | '60' | '90'>('30');
  const [showAddRecipient, setShowAddRecipient] = useState(false);
  const [selectedFieldIds, setSelectedFieldIds] = useState<string[]>([]);
  const selectedFieldId = selectedFieldIds.length === 1 ? selectedFieldIds[0]! : null;
  const setSelectedFieldId = (id: string | null) =>
    setSelectedFieldIds(id ? [id] : []);
  /**
   * Click handler for placed fields. Plain click → single-select (replace).
   * Shift/cmd/ctrl-click → toggle in selection (multi-select).
   */
  function onSelectField(id: string | null, additive: boolean) {
    if (id === null) {
      setSelectedFieldIds([]);
      return;
    }
    if (!additive) {
      setSelectedFieldIds([id]);
      return;
    }
    setSelectedFieldIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }
  const [toast, setToast] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null);

  // ─── Toast auto-dismiss ─────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Show toast on phase change to 'prepare'
  useEffect(() => {
    if (phase === 'prepare') {
      setToast({ kind: 'success', text: 'Draft created — Now add recipients and prepare your fields.' });
    }
  }, [phase]);

  // Show error on action failure
  useEffect(() => {
    if (state.error) setToast({ kind: 'error', text: state.error });
  }, [state.error]);

  // Keep activeRecipientId valid
  useEffect(() => {
    if (recipients.length === 0) { setActiveRecipientId(null); return; }
    if (!activeRecipientId || !recipients.some((r) => r.clientId === activeRecipientId)) {
      setActiveRecipientId(recipients[0]!.clientId);
    }
  }, [recipients, activeRecipientId]);

  // ─── File handling ──────────────────────────────────────────────
  async function onFilesChosen(files: File[]) {
    if (!files.length) return;
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
    if (!title.trim() && newDocs[0]) {
      const stem = newDocs[0].name.replace(/\.pdf$/i, '');
      setTitle(stem);
      if (!emailSubject.trim()) setEmailSubject(`Please sign: ${stem}`);
    }
  }
  function removeDocument(clientId: string) {
    setDocuments((cur) => cur.filter((d) => d.clientId !== clientId));
    setFields((cur) => cur.filter((f) => f.documentClientId !== clientId));
  }

  // ─── Recipient handling ─────────────────────────────────────────
  function addRecipient(name: string, email: string, role: 'SIGNER' | 'CC' | 'APPROVER' | 'WITNESS' | 'IN_PERSON_SIGNER' = 'SIGNER') {
    const r: RecipientDef = { clientId: crypto.randomUUID(), name, email, role };
    setRecipients((cur) => [...cur, r]);
    setActiveRecipientId(r.clientId);
    setToast({ kind: 'success', text: `${name || email} added as a recipient.` });
  }
  function updateRecipient(clientId: string, patch: Partial<RecipientDef>) {
    setRecipients((cur) => cur.map((r) => r.clientId === clientId ? { ...r, ...patch } : r));
  }
  function removeRecipient(clientId: string) {
    setRecipients((cur) => cur.filter((r) => r.clientId !== clientId));
    setFields((cur) => cur.filter((f) => f.recipientClientId !== clientId));
  }

  // ─── Field handling ─────────────────────────────────────────────
  function placeField(args: { documentClientId: string; page: number; type: FieldType; x: number; y: number }) {
    if (!activeRecipientId) {
      setToast({ kind: 'error', text: 'Select a recipient first.' });
      return;
    }
    const def = FIELD_DEFAULTS[args.type];
    const x = clamp01(args.x - def.w / 2);
    const y = clamp01(args.y - def.h / 2);
    const w = Math.min(def.w, 1 - x);
    const h = Math.min(def.h, 1 - y);
    const id = crypto.randomUUID();
    setFields((cur) => [
      ...cur,
      { id, documentClientId: args.documentClientId, recipientClientId: activeRecipientId, page: args.page, type: args.type, x, y, w, h, required: true },
    ]);
    setSelectedFieldId(id);
  }
  const moveField = (id: string, x: number, y: number) =>
    setFields((cur) => cur.map((f) => f.id === id ? { ...f, x: clamp01(x), y: clamp01(y) } : f));
  const removeField = (id: string) => {
    setFields((cur) => cur.filter((f) => f.id !== id));
    if (selectedFieldId === id) setSelectedFieldId(null);
  };
  const toggleRequired = (id: string) =>
    setFields((cur) => cur.map((f) => f.id === id ? { ...f, required: !f.required } : f));
  const updateField = (id: string, patch: Partial<FieldDef>) =>
    setFields((cur) => cur.map((f) => f.id === id ? { ...f, ...patch } : f));

  // ─── Anchor-tag autoplace ───────────────────────────────────────
  const [autoplacePending, setAutoplacePending] = useState(false);
  async function autoplaceFromTags() {
    if (!documents.length) {
      setToast({ kind: 'error', text: 'Upload a document first.' });
      return;
    }
    if (!recipients.length) {
      setToast({ kind: 'error', text: 'Add at least one recipient first.' });
      return;
    }
    setAutoplacePending(true);
    try {
      // Lazy-load the scanner so the builder bundle stays small for envelopes
      // that don't use anchor tags.
      const { scanAnchorTags } = await import('@/lib/pdf/anchor-tags');
      // Make sure pdfjs is initialised (worker, etc.) before we call into it.
      await loadPdfjs();
      const newFields: FieldDef[] = [];
      let unmatched = 0;
      for (const d of documents) {
        const buf = await d.file.arrayBuffer();
        const matches = await scanAnchorTags(buf);
        for (const m of matches) {
          const recipient = recipients[m.recipientOrder - 1];
          if (!recipient || recipient.role === 'CC' || recipient.role === 'APPROVER') {
            unmatched += 1;
            continue;
          }
          newFields.push({
            id: crypto.randomUUID(),
            documentClientId: d.clientId,
            recipientClientId: recipient.clientId,
            page: m.page,
            type: m.type as FieldType,
            x: clamp01(m.x),
            y: clamp01(m.y),
            w: Math.min(m.w, 1 - m.x),
            h: Math.min(m.h, 1 - m.y),
            required: true,
          });
        }
      }
      if (newFields.length === 0) {
        setToast({
          kind: 'error',
          text: unmatched > 0
            ? `Found ${unmatched} tag${unmatched === 1 ? '' : 's'} but no recipient matched the signing order. Add recipients in order.`
            : 'No anchor tags found. Use {{sig:1}}, {{date:1}}, {{text:1}}, etc. in your PDF.',
        });
        return;
      }
      setFields((cur) => [...cur, ...newFields]);
      setToast({
        kind: 'success',
        text: unmatched > 0
          ? `Placed ${newFields.length} field${newFields.length === 1 ? '' : 's'}. ${unmatched} tag${unmatched === 1 ? '' : 's'} skipped (no matching recipient).`
          : `Placed ${newFields.length} field${newFields.length === 1 ? '' : 's'} from anchor tags.`,
      });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Could not scan PDFs.' });
    } finally {
      setAutoplacePending(false);
    }
  }

  // ─── Continue to prepare ────────────────────────────────────────
  function continueToPrepare() {
    if (!documents.length || !title.trim()) {
      setToast({ kind: 'error', text: 'Add a document and a title to continue.' });
      return;
    }
    setPhase('prepare');
  }
  function exitPrepare() {
    setPhase('start');
    setSelectedFieldId(null);
  }

  // ─── Submit guard ───────────────────────────────────────────────
  function onSubmit(e: React.FormEvent) {
    if (documents.length === 0) {
      e.preventDefault();
      setToast({ kind: 'error', text: 'Add at least one document.' });
      return;
    }
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = submitter?.value === 'save' ? 'save' : 'send';
    // Drafts can be saved with no recipients yet; sending requires at least one.
    if (intent === 'send' && recipients.length === 0) {
      e.preventDefault();
      setToast({ kind: 'error', text: 'Add at least one recipient.' });
      return;
    }
    // Only block submit when a SIGNER has no fields. CC and APPROVER
    // recipients never need fields — APPROVERs gate routing via their
    // approve/decline action, no field interaction required.
    if (intent === 'send') {
      for (const r of recipients) {
        if (r.role === 'CC' || r.role === 'APPROVER') continue;
        const has = fields.some((f) => f.recipientClientId === r.clientId);
        if (!has) {
          e.preventDefault();
          setToast({ kind: 'error', text: `${r.name} doesn't have a signature field assigned.` });
          return;
        }
      }
    }
  }

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate>
      {/* Hidden state for the action */}
      <DocumentRefs documents={documents} />
      <input type="hidden" name="title" value={title} />
      <input type="hidden" name="message" value={message} />
      <input type="hidden" name="emailSubject" value={emailSubject} />
      <input type="hidden" name="routingMode" value={routingMode} />
      <input type="hidden" name="autoReminders" value={autoReminders ? 'true' : 'false'} />
      <input type="hidden" name="expiresInDays" value={expiresIn} />
      <input
        type="hidden"
        name="documents"
        value={JSON.stringify(documents.map((d, i) => ({ clientId: d.clientId, filename: d.name, pageCount: d.pageCount, order: i + 1 })))}
      />
      <input
        type="hidden"
        name="recipients"
        value={JSON.stringify(recipients.map((r, i) => ({
          clientId: r.clientId, name: r.name, email: r.email,
          signingOrder: i + 1, role: r.role, condition: r.condition,
        })))}
      />
      <input type="hidden" name="fields" value={JSON.stringify(fields)} />

      {/* PHASE 1: start */}
      <StartPhase
        documents={documents}
        title={title}
        setTitle={setTitle}
        emailSubject={emailSubject}
        setEmailSubject={setEmailSubject}
        message={message}
        setMessage={setMessage}
        onFilesChosen={onFilesChosen}
        onRemoveDocument={removeDocument}
        onContinue={continueToPrepare}
        titleError={state.fieldErrors?.title}
      />

      {/* PHASE 2: fullscreen prepare overlay */}
      {phase === 'prepare' && (
        <PreparePhase
          title={title}
          setTitle={setTitle}
          documents={documents}
          recipients={recipients}
          fields={fields}
          armedType={armedType}
          activeRecipientId={activeRecipientId}
          routingMode={routingMode}
          autoReminders={autoReminders}
          expiresIn={expiresIn}
          selectedFieldId={selectedFieldId}
          setActiveRecipientId={setActiveRecipientId}
          setArmedType={setArmedType}
          setRoutingMode={setRoutingMode}
          setAutoReminders={setAutoReminders}
          setExpiresIn={setExpiresIn}
          selectedFieldIds={selectedFieldIds}
          setSelectedFieldId={setSelectedFieldId}
          onSelectField={onSelectField}
          onAddRecipientClick={() => setShowAddRecipient(true)}
          onRemoveRecipient={removeRecipient}
          onUpdateRecipient={updateRecipient}
          onPlaceField={(args) => { placeField(args); setArmedType(null); }}
          onMoveField={moveField}
          onRemoveField={removeField}
          onToggleRequired={toggleRequired}
          onUpdateField={updateField}
          onAutoplaceFromTags={autoplaceFromTags}
          autoplacePending={autoplacePending}
          onExit={exitPrepare}
        />
      )}

      {/* Add recipient modal */}
      {showAddRecipient && (
        <AddRecipientModal
          existing={recipients}
          onCancel={() => setShowAddRecipient(false)}
          onAdd={(name, email, role) => { addRecipient(name, email, role); setShowAddRecipient(false); }}
        />
      )}

      {/* Toast */}
      {toast && <Toast kind={toast.kind} text={toast.text} onClose={() => setToast(null)} />}
    </form>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PHASE 1: Start
   ═══════════════════════════════════════════════════════════════ */
function StartPhase({
  documents, title, setTitle, emailSubject, setEmailSubject, message, setMessage,
  onFilesChosen, onRemoveDocument, onContinue, titleError,
}: {
  documents: DocumentDef[];
  title: string; setTitle: (v: string) => void;
  emailSubject: string; setEmailSubject: (v: string) => void;
  message: string; setMessage: (v: string) => void;
  onFilesChosen: (files: File[]) => void | Promise<void>;
  onRemoveDocument: (id: string) => void;
  onContinue: () => void;
  titleError?: string;
}) {
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const subjectId = useId();
  const messageId = useId();

  function onDropZone(e: DragEvent<HTMLDivElement>) {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) onFilesChosen(files);
  }
  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    if (files.length) onFilesChosen(files);
  }

  const ready = documents.length > 0 && title.trim().length > 0;

  return (
    <div className="grid grid-cols-1 gap-4">
      {/* Upload zone */}
      <div className="rounded-lg border border-hairline bg-surface">
        <div className="px-5 pt-4 pb-3 border-b border-hairline flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-muted text-ink-secondary">
            <UploadIcon />
          </span>
          <div>
            <h2 className="text-[14.5px] font-semibold text-ink">Upload documents</h2>
            <p className="text-[12.5px] text-ink-tertiary">Drop in PDFs. Up to 25 MB each.</p>
          </div>
        </div>
        <div className="p-5">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDropZone}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
            role="button"
            tabIndex={0}
            className={`rounded-lg border-2 border-dashed transition-colors cursor-pointer flex flex-col items-center justify-center text-center px-8 py-12 ${
              dragOver ? 'border-accent bg-accent-soft/40' : 'border-hairline-strong bg-surface-muted/30 hover:bg-surface-muted/60'
            }`}
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-surface border border-hairline text-ink-secondary">
              <UploadIcon />
            </span>
            <p className="mt-3 text-[14px] font-semibold text-ink">Drag &amp; drop PDFs here</p>
            <p className="mt-1 text-[12.5px] text-ink-tertiary">or click to browse — PDFs only, up to 25MB each</p>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              multiple
              onChange={onChange}
              className="sr-only"
              aria-label="Add PDF documents"
            />
          </div>

          {documents.length > 0 && (
            <ul className="mt-4 rounded-md border border-hairline bg-surface divide-y divide-hairline overflow-hidden">
              {documents.map((d) => (
                <li key={d.clientId} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-status-declined-bg text-status-declined">
                    <FileIcon />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-ink truncate">{d.name}</p>
                    <p className="text-[11.5px] text-ink-tertiary">
                      {d.pageCount} page{d.pageCount === 1 ? '' : 's'} · {(d.file.size / 1024).toFixed(1)} KB · Ready
                    </p>
                  </div>
                  <button type="button" onClick={() => onRemoveDocument(d.clientId)} className="p-1 rounded-md text-ink-tertiary hover:bg-surface-muted hover:text-status-declined">
                    <X />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Meta fields appear once a document is uploaded */}
          {documents.length > 0 && (
            <div className="mt-5 grid grid-cols-1 gap-4">
              <label htmlFor={titleId} className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-secondary">Document name</span>
                <input
                  id={titleId}
                  value={title}
                  onChange={(e) => setTitle(e.currentTarget.value)}
                  placeholder="e.g. Mutual NDA — Acme Bio Research"
                  aria-invalid={titleError ? 'true' : 'false'}
                  className="h-9 px-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
                {titleError && <p className="text-[12px] text-status-declined">{titleError}</p>}
              </label>
              <label htmlFor={subjectId} className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-secondary">Email subject</span>
                <input
                  id={subjectId}
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.currentTarget.value)}
                  placeholder="Please sign…"
                  className="h-9 px-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
              </label>
              <label htmlFor={messageId} className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-secondary">Message to recipients</span>
                <textarea
                  id={messageId}
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.currentTarget.value)}
                  placeholder="Optional — appears in the email recipients receive"
                  className="px-3 py-2 rounded-md bg-surface border border-hairline text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
                />
              </label>
              <div className="flex justify-end mt-1">
                <button
                  type="button"
                  onClick={onContinue}
                  disabled={!ready}
                  className="inline-flex h-10 items-center gap-1.5 rounded-md bg-canvas px-5 text-[13.5px] font-medium text-white border border-canvas hover:bg-canvas-edge transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue to prepare <ArrowRight />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PHASE 2: Prepare (fullscreen)
   ═══════════════════════════════════════════════════════════════ */
function PreparePhase(props: {
  title: string;
  setTitle: (v: string) => void;
  documents: DocumentDef[];
  recipients: RecipientDef[];
  fields: FieldDef[];
  armedType: FieldType | null;
  activeRecipientId: string | null;
  routingMode: 'SEQUENTIAL' | 'PARALLEL';
  autoReminders: boolean;
  expiresIn: '7' | '14' | '30' | '60' | '90';
  selectedFieldId: string | null;
  selectedFieldIds: string[];
  setActiveRecipientId: (id: string) => void;
  setArmedType: (t: FieldType | null) => void;
  setRoutingMode: (m: 'SEQUENTIAL' | 'PARALLEL') => void;
  setAutoReminders: (v: boolean) => void;
  setExpiresIn: (v: '7' | '14' | '30' | '60' | '90') => void;
  setSelectedFieldId: (id: string | null) => void;
  onSelectField: (id: string | null, additive: boolean) => void;
  onAddRecipientClick: () => void;
  onRemoveRecipient: (id: string) => void;
  onUpdateRecipient: (id: string, patch: Partial<RecipientDef>) => void;
  onPlaceField: (args: { documentClientId: string; page: number; type: FieldType; x: number; y: number }) => void;
  onMoveField: (id: string, x: number, y: number) => void;
  onRemoveField: (id: string) => void;
  onToggleRequired: (id: string) => void;
  onUpdateField: (id: string, patch: Partial<FieldDef>) => void;
  onAutoplaceFromTags: () => void;
  autoplacePending: boolean;
  onExit: () => void;
}) {
  const selectedField = props.fields.find((f) => f.id === props.selectedFieldId) ?? null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-page" role="region" aria-label="Document preparation">
      {/* Top bar */}
      <header className="bg-surface border-b border-hairline h-14 flex items-center px-4 lg:px-6 gap-3">
        <button
          type="button"
          onClick={props.onExit}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink-secondary hover:bg-surface-muted hover:text-ink"
        >
          <ChevronLeft /> Exit
        </button>
        <span className="h-5 w-px bg-hairline" aria-hidden="true" />
        <input
          value={props.title}
          onChange={(e) => props.setTitle(e.currentTarget.value)}
          aria-label="Document name"
          className="h-8 min-w-0 flex-1 max-w-[480px] px-2 -mx-2 rounded-md text-[14px] font-semibold tracking-[-0.012em] text-ink bg-transparent outline-none focus:bg-surface-muted/60"
        />
        <div className="ml-auto flex items-center gap-2">
          <SaveDraftButton />
          <SubmitButton />
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_280px] min-h-0">
        {/* Left rail */}
        <LeftRail
          recipients={props.recipients}
          activeRecipientId={props.activeRecipientId}
          fields={props.fields}
          armedType={props.armedType}
          routingMode={props.routingMode}
          autoReminders={props.autoReminders}
          expiresIn={props.expiresIn}
          onAddRecipientClick={props.onAddRecipientClick}
          onRemoveRecipient={props.onRemoveRecipient}
          onUpdateRecipient={props.onUpdateRecipient}
          onPickRecipient={props.setActiveRecipientId}
          onArm={props.setArmedType}
          onRoutingChange={props.setRoutingMode}
          onAutoRemindersChange={props.setAutoReminders}
          onExpiresChange={props.setExpiresIn}
          onAutoplaceFromTags={props.onAutoplaceFromTags}
          autoplacePending={props.autoplacePending}
        />

        {/* Center: document canvas */}
        <DocumentArea
          documents={props.documents}
          fields={props.fields}
          recipients={props.recipients}
          armedType={props.armedType}
          activeRecipientId={props.activeRecipientId}
          selectedFieldId={props.selectedFieldId}
          selectedFieldIds={props.selectedFieldIds}
          onPlace={props.onPlaceField}
          onMove={props.onMoveField}
          onRemove={props.onRemoveField}
          onSelectField={props.onSelectField}
          onClearSelection={() => props.setSelectedFieldId(null)}
          onToggleRequired={props.onToggleRequired}
          onUpdateField={props.onUpdateField}
        />

        {/* Right rail */}
        <RightRail
          selectedField={selectedField}
          recipients={props.recipients}
          allFields={props.fields}
          armedType={props.armedType}
          activeRecipientId={props.activeRecipientId}
          onToggleRequired={props.onToggleRequired}
          onUpdateField={props.onUpdateField}
          onRemoveField={props.onRemoveField}
          onCancelArm={() => props.setArmedType(null)}
        />
      </div>
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="intent"
      value="send"
      disabled={pending}
      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-[13px] font-medium text-white border border-accent-deep hover:bg-accent-deep transition-colors disabled:opacity-50"
    >
      {pending ? 'Sending…' : (<>Send for signature <SendIconSm /></>)}
    </button>
  );
}
function SaveDraftButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="intent"
      value="save"
      disabled={pending}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-muted/60 disabled:opacity-50"
    >
      <SaveIcon /> {pending ? 'Saving…' : 'Save draft'}
    </button>
  );
}

/* ─── Left rail ─────────────────────────────────────────────────── */
function LeftRail(props: {
  recipients: RecipientDef[];
  activeRecipientId: string | null;
  fields: FieldDef[];
  armedType: FieldType | null;
  routingMode: 'SEQUENTIAL' | 'PARALLEL';
  autoReminders: boolean;
  expiresIn: string;
  onAddRecipientClick: () => void;
  onRemoveRecipient: (id: string) => void;
  onUpdateRecipient: (id: string, patch: Partial<RecipientDef>) => void;
  onPickRecipient: (id: string) => void;
  onArm: (t: FieldType | null) => void;
  onRoutingChange: (m: 'SEQUENTIAL' | 'PARALLEL') => void;
  onAutoRemindersChange: (v: boolean) => void;
  onExpiresChange: (v: '7' | '14' | '30' | '60' | '90') => void;
  onAutoplaceFromTags: () => void;
  autoplacePending: boolean;
}) {
  const activeRecipient = props.recipients.find((r) => r.clientId === props.activeRecipientId);
  const fieldsDisabled = props.recipients.length === 0
    || activeRecipient?.role === 'CC'
    || activeRecipient?.role === 'APPROVER';
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreFilter, setMoreFilter] = useState('');
  const commonTypes: FieldType[] = [
    'SIGNATURE', 'INITIALS', 'DATE', 'TEXT',
    'CHECKBOX', 'NAME', 'EMAIL', 'JOB_TITLE',
  ];
  const moreTypes: FieldType[] = [
    'NUMBER', 'PHONE', 'ADDRESS', 'COMPANY',
    'DROPDOWN', 'RADIO', 'FORMULA', 'ATTACHMENT',
    'APPROVE', 'DECLINE', 'NOTE', 'LINE', 'STAMP',
    'DRAWING',
  ];
  const filteredMore = moreTypes.filter((t) =>
    moreFilter.trim() === '' ||
    FIELD_DEFAULTS[t].label.toLowerCase().includes(moreFilter.toLowerCase().trim()),
  );

  return (
    <aside className="bg-surface border-r border-hairline overflow-y-auto">
      {/* Recipients */}
      <section className="px-4 pt-4 pb-3 border-b border-hairline">
        <div className="flex items-center justify-between">
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Recipients</h3>
          <button
            type="button"
            onClick={props.onAddRecipientClick}
            data-testid="builder-add-recipient"
            aria-label="Add recipient"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[12px] font-medium text-ink hover:bg-surface-muted/60"
          >
            <Plus /> Add
          </button>
        </div>

        {props.recipients.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-tertiary leading-snug">
            No recipients yet. Add at least one to start placing fields.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {props.recipients.map((r, idx) => {
              const c = colorForRecipient(idx);
              const active = r.clientId === props.activeRecipientId;
              const fieldCount = props.fields.filter((f) => f.recipientClientId === r.clientId).length;
              return (
                <li key={r.clientId}>
                  <button
                    type="button"
                    onClick={() => props.onPickRecipient(r.clientId)}
                    style={active ? { borderColor: c.fg, background: c.bg } : undefined}
                    className={`w-full text-left rounded-md border px-2.5 py-2 flex items-center gap-2.5 transition-colors group ${
                      active ? '' : 'border-hairline bg-surface hover:bg-surface-muted/60'
                    }`}
                  >
                    <span
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold flex-shrink-0"
                      style={{ background: c.bg, color: c.fg }}
                    >
                      {idx + 1}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="block text-[12.5px] font-medium text-ink truncate">{r.name || '(no name)'}</span>
                        {r.role === 'CC' && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-tertiary border border-hairline rounded px-1 py-px">CC</span>
                        )}
                        {r.role === 'APPROVER' && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-status-progress border border-status-progress-border rounded px-1 py-px">Approver</span>
                        )}
                        {r.role === 'WITNESS' && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-status-sent border border-status-sent-border rounded px-1 py-px">Witness</span>
                        )}
                        {r.role === 'IN_PERSON_SIGNER' && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-accent border border-accent/40 rounded px-1 py-px">In-person</span>
                        )}
                      </span>
                      <span className="block text-[11px] text-ink-tertiary truncate">{r.email}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      {fieldCount > 0 && (
                        <span className="font-mono text-[10px] text-ink-tertiary tabular-nums">{fieldCount}</span>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); props.onRemoveRecipient(r.clientId); }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-ink-tertiary hover:text-status-declined"
                        aria-label={`Remove ${r.name}`}
                      >
                        <X />
                      </button>
                    </span>
                  </button>
                  {active && idx > 0 && (
                    <RecipientRoutingEditor
                      recipient={r}
                      earlierFields={props.fields.filter((field) => {
                        const fieldRecipientIdx = props.recipients.findIndex((x) => x.clientId === field.recipientClientId);
                        return fieldRecipientIdx >= 0 && fieldRecipientIdx < idx;
                      })}
                      earlierRecipients={props.recipients.slice(0, idx)}
                      onUpdate={(patch) => props.onUpdateRecipient(r.clientId, patch)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Fields */}
      <section className="px-4 pt-4 pb-3 border-b border-hairline">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Fields</h3>
        {props.recipients.length === 0 ? (
          <p className="mt-2 text-[12px] text-ink-tertiary leading-snug">Add a recipient first.</p>
        ) : activeRecipient?.role === 'CC' ? (
          <p className="mt-2 text-[12px] text-ink-tertiary leading-snug">
            <span className="text-ink font-medium">{activeRecipient.name}</span> is a CC and doesn't sign — pick a signer to place fields.
          </p>
        ) : activeRecipient?.role === 'APPROVER' ? (
          <p className="mt-2 text-[12px] text-ink-tertiary leading-snug">
            <span className="text-ink font-medium">{activeRecipient.name}</span> is an approver — they review the document and click Approve, no fields needed.
          </p>
        ) : (
          <p className="mt-2 text-[12px] text-ink-tertiary leading-snug">
            Drag onto the document to assign to <span className="text-ink font-medium">{activeRecipient?.name || 'recipient'}</span>.
          </p>
        )}
        <div className={fieldsDisabled ? 'opacity-40 pointer-events-none' : ''}>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {commonTypes.map((t) => {
              const activeIdx = props.recipients.findIndex((r) => r.clientId === props.activeRecipientId);
              const c = activeIdx >= 0 ? colorForRecipient(activeIdx) : null;
              return (
                <FieldTile
                  key={t}
                  type={t}
                  armed={props.armedType === t}
                  color={c}
                  onArm={() => props.onArm(props.armedType === t ? null : t)}
                />
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            className="mt-2 w-full inline-flex items-center justify-between gap-1 px-2 py-1.5 rounded-md text-[12px] font-medium text-ink-secondary hover:text-ink hover:bg-surface-muted/60 transition-colors"
          >
            <span>{moreOpen ? 'Hide' : 'More fields'} <span className="text-ink-tertiary">({moreTypes.length})</span></span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {moreOpen && (
            <div className="mt-1.5 space-y-1.5">
              <div className="relative">
                <input
                  type="search"
                  value={moreFilter}
                  onChange={(e) => setMoreFilter(e.currentTarget.value)}
                  placeholder="Filter fields"
                  aria-label="Filter additional fields"
                  className="w-full h-8 pl-7 pr-2.5 rounded-md bg-surface border border-hairline text-[12px] text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-tertiary">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                </span>
              </div>
              {filteredMore.length === 0 ? (
                <p className="text-[11.5px] text-ink-tertiary py-1.5 text-center">No matches.</p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {filteredMore.map((t) => {
                    const activeIdx = props.recipients.findIndex((r) => r.clientId === props.activeRecipientId);
                    const c = activeIdx >= 0 ? colorForRecipient(activeIdx) : null;
                    return (
                      <FieldTile
                        key={t}
                        type={t}
                        armed={props.armedType === t}
                        color={c}
                        onArm={() => props.onArm(props.armedType === t ? null : t)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={props.onAutoplaceFromTags}
          disabled={props.autoplacePending || props.recipients.length === 0}
          aria-label="Auto-detect anchor tags in the PDF (e.g. {{sig:1}}) and place fields automatically"
          title={`Auto-place fields by scanning the PDF for {{sig:N}}, {{date:N}}, {{init:N}} markers.\nThe number = recipient signing order. The marker is replaced by the placed field.`}
          className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-ink-tertiary hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <SparkleIcon />
          <span className="underline-offset-2 hover:underline">
            {props.autoplacePending ? 'Detecting…' : 'Auto-detect from PDF tags'}
          </span>
        </button>
      </section>

      {/* Send options */}
      <section className="px-4 pt-4 pb-5">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Send options</h3>
        <div className="mt-2 flex flex-col gap-2.5">
          <ToggleRow
            label="Sequential signing"
            description="Recipients sign one at a time, in order."
            checked={props.routingMode === 'SEQUENTIAL'}
            onChange={(v) => props.onRoutingChange(v ? 'SEQUENTIAL' : 'PARALLEL')}
          />
          <ToggleRow
            label="Auto reminders"
            description="Email recipients every 3 days until signed."
            checked={props.autoReminders}
            onChange={props.onAutoRemindersChange}
          />
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink">Expires in</span>
            <Select
              value={props.expiresIn}
              onChange={(v) => props.onExpiresChange(v as '7' | '14' | '30' | '60' | '90')}
              ariaLabel="Envelope expiration"
              options={[
                { value: '7',  label: '7 days' },
                { value: '14', label: '14 days' },
                { value: '30', label: '30 days' },
                { value: '60', label: '60 days' },
                { value: '90', label: '90 days' },
              ]}
            />
          </label>
        </div>
      </section>
    </aside>
  );
}

function FieldTile({
  type, armed, color, onArm,
}: { type: FieldType; armed: boolean; color: { fg: string; bg: string } | null; onArm: () => void }) {
  function onDragStart(e: DragEvent<HTMLButtonElement>) {
    e.dataTransfer.setData('text/x-docuridge-field', type);
    e.dataTransfer.effectAllowed = 'copy';
    // Custom drag image that matches the placed-field appearance
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position: absolute; top: -1000px; left: -1000px;
      padding: 6px 12px; border-radius: 4px; font-size: 12px;
      font-weight: 500; background: ${color?.bg ?? 'rgba(15,17,21,0.1)'};
      color: ${color?.fg ?? '#0F1115'}; border: 2px solid ${color?.fg ?? '#0F1115'};
      box-shadow: 0 4px 12px rgba(15,17,21,0.18);
      font-family: var(--font-sans), system-ui, sans-serif;
    `;
    ghost.textContent = FIELD_DEFAULTS[type].label;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 14);
    setTimeout(() => ghost.remove(), 0);
  }
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onArm}
      aria-pressed={armed}
      aria-label={`Place a ${FIELD_DEFAULTS[type].label} field`}
      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-[12.5px] font-medium cursor-grab active:cursor-grabbing transition-colors ${
        armed
          ? ''
          : 'border-hairline bg-surface text-ink hover:bg-surface-muted/60'
      }`}
      style={armed && color
        ? { borderColor: color.fg, background: color.bg, color: color.fg }
        : undefined}
    >
      <span className="flex-shrink-0" style={color ? { color: color.fg } : undefined}>
        <FieldTileIcon type={type} />
      </span>
      <span>{FIELD_DEFAULTS[type].label}</span>
    </button>
  );
}

function ToggleRow({
  label, description, checked, onChange,
}: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="flex-1 min-w-0">
        <span className="block text-[12.5px] font-medium text-ink">{label}</span>
        {description && <span className="block text-[11px] text-ink-tertiary leading-snug">{description}</span>}
      </span>
      <span className="relative inline-flex h-5 w-9 flex-shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={`absolute inset-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-muted'} peer-focus-visible:ring-3 peer-focus-visible:ring-accent/15`}
        />
        <span
          aria-hidden="true"
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
        />
      </span>
    </label>
  );
}

/* ─── Center: document area ──────────────────────────────────── */
function DocumentArea(props: {
  documents: DocumentDef[];
  fields: FieldDef[];
  recipients: RecipientDef[];
  armedType: FieldType | null;
  activeRecipientId: string | null;
  selectedFieldId: string | null;
  selectedFieldIds: string[];
  onPlace: (args: { documentClientId: string; page: number; type: FieldType; x: number; y: number }) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRemove: (id: string) => void;
  onSelectField: (id: string | null, additive: boolean) => void;
  onClearSelection: () => void;
  onToggleRequired: (id: string) => void;
  onUpdateField: (id: string, patch: Partial<FieldDef>) => void;
}) {
  return (
    <main className="overflow-y-auto bg-surface-muted/30 px-6 lg:px-8 py-6 min-h-0" onClick={props.onClearSelection}>
      {props.documents.map((doc) => (
        <DocumentBlock
          key={doc.clientId}
          doc={doc}
          fields={props.fields.filter((f) => f.documentClientId === doc.clientId)}
          recipients={props.recipients}
          armedType={props.armedType}
          activeRecipientId={props.activeRecipientId}
          selectedFieldId={props.selectedFieldId}
          selectedFieldIds={props.selectedFieldIds}
          onPlace={(page, type, x, y) => props.onPlace({ documentClientId: doc.clientId, page, type, x, y })}
          onMove={props.onMove}
          onRemove={props.onRemove}
          onSelectField={props.onSelectField}
          onToggleRequired={props.onToggleRequired}
          onUpdateField={props.onUpdateField}
        />
      ))}
    </main>
  );
}

function DocumentBlock(props: {
  doc: DocumentDef;
  fields: FieldDef[];
  recipients: RecipientDef[];
  armedType: FieldType | null;
  activeRecipientId: string | null;
  selectedFieldId: string | null;
  selectedFieldIds: string[];
  onPlace: (page: number, type: FieldType, x: number, y: number) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRemove: (id: string) => void;
  onSelectField: (id: string | null, additive: boolean) => void;
  onToggleRequired: (id: string) => void;
  onUpdateField: (id: string, patch: Partial<FieldDef>) => void;
}) {
  return (
    <div className="mx-auto max-w-[820px] mb-6">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[12.5px] font-medium text-ink-secondary truncate">{props.doc.name}</p>
        <p className="text-[11px] font-mono text-ink-tertiary">
          {props.doc.pageCount} page{props.doc.pageCount === 1 ? '' : 's'}
        </p>
      </div>
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
            selectedFieldId={props.selectedFieldId}
            selectedFieldIds={props.selectedFieldIds}
            onPlace={(t, x, y) => props.onPlace(page, t, x, y)}
            onMove={props.onMove}
            onRemove={props.onRemove}
            onSelectField={props.onSelectField}
            onToggleRequired={props.onToggleRequired}
            onUpdateField={props.onUpdateField}
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
  selectedFieldId: string | null;
  selectedFieldIds: string[];
  onPlace: (t: FieldType, x: number, y: number) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRemove: (id: string) => void;
  onSelectField: (id: string | null, additive: boolean) => void;
  onToggleRequired: (id: string) => void;
  onUpdateField: (id: string, patch: Partial<FieldDef>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

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
    })().catch(() => { if (!cancelled) setDimensions({ w: 800, h: 1000 }); });
    return () => { cancelled = true; };
  }, [props.doc.file, props.page]);

  function fractionalFromEvent(e: { clientX: number; clientY: number }) {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0.5, y: 0.5 };
    const rect = wrap.getBoundingClientRect();
    return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes('text/x-docuridge-field')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const { x, y } = fractionalFromEvent(e);
      setHoverPos({ x, y });
    }
  }
  function onDragLeave() { setHoverPos(null); }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setHoverPos(null);
    const data = e.dataTransfer.getData('text/x-docuridge-field');
    if (!data) return;
    const moveId = e.dataTransfer.getData('text/x-docuridge-move');
    const { x, y } = fractionalFromEvent(e);
    if (moveId) props.onMove(moveId, x, y); else props.onPlace(data as FieldType, x, y);
  }
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (!props.armedType) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-placed-field]')) return;
    const { x, y } = fractionalFromEvent(e);
    props.onPlace(props.armedType, x, y);
  }

  const armed = props.armedType !== null && props.activeRecipientId !== null;
  const activeRecipientIdx = props.recipients.findIndex((r) => r.clientId === props.activeRecipientId);
  const armedColor = activeRecipientIdx >= 0 ? colorForRecipient(activeRecipientIdx) : null;
  const ghostDef = props.armedType ? FIELD_DEFAULTS[props.armedType] : null;

  return (
    <div className="relative inline-block w-full" data-testid={`page-${props.doc.clientId}-${props.page}`}>
      <div className="text-[10.5px] font-mono text-ink-tertiary mb-1 px-1 uppercase tracking-[0.06em]">Page {props.page}</div>
      <div
        ref={wrapRef}
        data-loaded={dimensions ? 'true' : 'false'}
        data-page-target=""
        data-armed-type={props.armedType ?? ''}
        data-active-recipient={props.activeRecipientId ?? ''}
        style={dimensions ? { aspectRatio: `${dimensions.w}/${dimensions.h}` } : undefined}
        className={`relative w-full overflow-hidden rounded-lg shadow-[0_4px_16px_rgba(15,17,21,0.06)] border bg-surface transition-colors ${
          armed
            ? 'border-accent border-2 cursor-crosshair'
            : 'border-hairline'
        }`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onClick}
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
              recipients={props.recipients}
              color={color}
              selected={props.selectedFieldIds.includes(f.id)}
              onMove={(x, y) => props.onMove(f.id, x, y)}
              onRemove={() => props.onRemove(f.id)}
              onSelect={(additive) => props.onSelectField(f.id, additive)}
              onReassign={(newRid) => props.onUpdateField(f.id, { recipientClientId: newRid })}
            />
          );
        })}
        {dimensions && (() => {
          const selectedOnPage = props.fields.filter((f) => props.selectedFieldIds.includes(f.id));
          if (selectedOnPage.length === 0) return null;
          return (
            <FieldToolbar
              fields={selectedOnPage}
              onToggleRequired={props.onToggleRequired}
              onUpdateField={props.onUpdateField}
              onRemove={props.onRemove}
            />
          );
        })()}
        {/* Ghost field preview while dragging */}
        {hoverPos && armedColor && ghostDef && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: `${(hoverPos.x - ghostDef.w / 2) * 100}%`,
              top: `${(hoverPos.y - ghostDef.h / 2) * 100}%`,
              width: `${ghostDef.w * 100}%`,
              height: `${ghostDef.h * 100}%`,
              background: armedColor.bg,
              border: `2px dashed ${armedColor.fg}`,
              pointerEvents: 'none',
            }}
            className="rounded"
          />
        )}
      </div>
    </div>
  );
}

function PlacedFieldMark(props: {
  field: FieldDef;
  recipientIndex: number;
  recipients: RecipientDef[];
  color: { fg: string; bg: string } | null;
  selected: boolean;
  onMove: (x: number, y: number) => void;
  onRemove: () => void;
  onSelect: (additive: boolean) => void;
  onReassign: (newRecipientClientId: string) => void;
}) {
  const f = props.field;
  const ref = useRef<HTMLDivElement>(null);
  // Pointer-event drag — HTML5 drag-and-drop was flaky here; pointer events
  // give us frame-perfect movement without browser quirks. We track movement
  // in fractional coords relative to the parent page-target.
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startFieldX: number;
    startFieldY: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // Don't initiate a drag from the X close button or the assignee chip.
    if ((e.target as HTMLElement).closest('button[aria-label="Remove field"]')) return;
    if ((e.target as HTMLElement).closest('[data-assignee-chip]')) return;
    e.stopPropagation();
    const node = ref.current;
    if (!node) return;
    node.setPointerCapture(e.pointerId);
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startFieldX: f.x,
      startFieldY: f.y,
      pointerId: e.pointerId,
      moved: false,
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const ds = dragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    const wrap = ref.current?.parentElement; // the page-target div
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dxFrac = (e.clientX - ds.startClientX) / rect.width;
    const dyFrac = (e.clientY - ds.startClientY) / rect.height;
    if (Math.hypot(e.clientX - ds.startClientX, e.clientY - ds.startClientY) > 3) {
      ds.moved = true;
    }
    props.onMove(clamp01(ds.startFieldX + dxFrac), clamp01(ds.startFieldY + dyFrac));
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const ds = dragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    ref.current?.releasePointerCapture(e.pointerId);
    // Click without drag → select. Drag → already moved; just select on commit.
    // Shift / cmd / ctrl held → additive multi-select.
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    props.onSelect(additive);
    dragRef.current = null;
    e.stopPropagation();
  }

  function onPointerCancel() {
    dragRef.current = null;
  }

  const c = props.color ?? { fg: '#265558', bg: 'rgba(61,133,133,0.18)' };
  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-placed-field={f.id}
      role="group"
      aria-label={`Placed ${FIELD_DEFAULTS[f.type].label} field for recipient ${props.recipientIndex + 1}, ${f.required ? 'required' : 'optional'}`}
      style={{
        position: 'absolute',
        left: `${f.x * 100}%`,
        top: `${f.y * 100}%`,
        width: `${f.w * 100}%`,
        height: `${f.h * 100}%`,
        background: c.bg,
        border: `2px solid ${c.fg}`,
        borderStyle: f.required ? 'solid' : 'dashed',
        boxShadow: props.selected ? `0 0 0 3px ${c.fg}33` : undefined,
        touchAction: 'none', // prevent browser scrolling while dragging on touch
      }}
      className="group rounded cursor-grab active:cursor-grabbing flex items-center justify-center text-[10px] font-medium hover:brightness-95 select-none"
    >
      <span className="px-1 truncate pointer-events-none" style={{ color: c.fg }}>
        {FIELD_DEFAULTS[f.type].label}
      </span>
      <AssigneeChip
        recipients={props.recipients}
        currentRecipientId={f.recipientClientId}
        color={c}
        onReassign={props.onReassign}
      />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); props.onRemove(); }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Remove field"
        style={{ background: c.fg }}
        className="absolute -top-2 -right-2 h-5 w-5 rounded-full text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 hover:brightness-110 cursor-pointer"
      >
        <X />
      </button>
    </div>
  );
}

/**
 * Small pill on a placed field showing which recipient it's assigned to.
 * Click opens a portalled popover for fast reassignment without touching
 * the right rail. The chip sits at the top-left of the field, outside the
 * main hit area, and shows the recipient's order number plus a short label.
 */
function AssigneeChip({
  recipients, currentRecipientId, color, onReassign,
}: {
  recipients: RecipientDef[];
  currentRecipientId: string;
  color: { fg: string; bg: string };
  onReassign: (newRecipientClientId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const idx = recipients.findIndex((r) => r.clientId === currentRecipientId);
  const me = idx >= 0 ? recipients[idx] : null;

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, left: r.left });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = triggerRef.current;
      const p = popRef.current;
      const target = e.target as Node;
      if (t && t.contains(target)) return;
      if (p && p.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!me) return null;
  const initial = (me.name || me.email || '?').trim().charAt(0).toUpperCase();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-assignee-chip
        aria-label={`Assigned to ${me.name || me.email}. Click to reassign.`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{ background: color.fg }}
        className="absolute -top-2 -left-2 h-5 px-1.5 rounded-full text-white text-[9.5px] font-semibold flex items-center gap-1 opacity-0 group-hover:opacity-100 hover:brightness-110 cursor-pointer shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
      >
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white/25 text-[8.5px]">
          {idx + 1}
        </span>
        <span className="leading-none truncate max-w-[60px]">{initial}</span>
      </button>
      {open && coords && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popRef}
            role="menu"
            aria-label="Reassign field to recipient"
            style={{ position: 'fixed', top: coords.top, left: coords.left, zIndex: 1000 }}
            className="min-w-[200px] rounded-md border border-hairline bg-surface shadow-[0_8px_24px_rgba(15,17,21,0.12)] py-1"
          >
            <div className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">
              Assign to
            </div>
            {recipients.map((r, i) => {
              const isMe = r.clientId === currentRecipientId;
              const rc = colorForRecipient(i);
              return (
                <button
                  key={r.clientId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isMe}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isMe) onReassign(r.clientId);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-muted ${isMe ? 'font-medium text-ink' : 'text-ink-secondary'}`}
                >
                  <span
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-white text-[9px] font-semibold flex-shrink-0"
                    style={{ background: rc.fg }}
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{r.name || '(no name)'}</span>
                    <span className="block text-[10.5px] text-ink-tertiary truncate">{r.email}</span>
                  </span>
                  {isMe && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-ink-secondary">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      }
    </>
  );
}

/* ─── Right rail ─────────────────────────────────────────────── */
function RightRail(props: {
  selectedField: FieldDef | null;
  recipients: RecipientDef[];
  /** Full field set — needed so the conditional-logic picker can list other fields as possible sources. */
  allFields: FieldDef[];
  armedType: FieldType | null;
  activeRecipientId: string | null;
  onToggleRequired: (id: string) => void;
  onUpdateField: (id: string, patch: Partial<FieldDef>) => void;
  onRemoveField: (id: string) => void;
  onCancelArm: () => void;
}) {
  if (props.selectedField) {
    const f = props.selectedField;
    const recipientIdx = props.recipients.findIndex((r) => r.clientId === f.recipientClientId);
    const c = recipientIdx >= 0 ? colorForRecipient(recipientIdx) : null;
    const r = recipientIdx >= 0 ? props.recipients[recipientIdx]! : null;
    const isText  = f.type === 'TEXT' || f.type === 'NUMBER' || f.type === 'JOB_TITLE' ||
                    f.type === 'PHONE' || f.type === 'COMPANY' || f.type === 'ADDRESS';
    const isNumeric = f.type === 'NUMBER';
    const isSelection = f.type === 'DROPDOWN' || f.type === 'RADIO';
    const isFormula = f.type === 'FORMULA';
    const isNote = f.type === 'NOTE';
    const isStamp = f.type === 'STAMP';
    return (
      <aside className="bg-surface border-l border-hairline overflow-y-auto p-5">
        <div className="flex items-center gap-2">
          {c && (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: c.bg, color: c.fg }}>
              {recipientIdx + 1}
            </span>
          )}
          <h3 className="text-[14px] font-semibold text-ink">{FIELD_DEFAULTS[f.type].label} field</h3>
        </div>
        {r && (
          <p className="mt-1 text-[12px] text-ink-tertiary">
            Assigned to <span className="text-ink font-medium">{r.name || r.email}</span>
          </p>
        )}
        <div className="mt-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] text-ink">Required</span>
            <ToggleSwitch checked={f.required} onChange={() => props.onToggleRequired(f.id)} />
          </div>

          {isStamp && (
            <StampSection
              field={f}
              onUpdate={(patch) => props.onUpdateField(f.id, patch)}
            />
          )}

          {isNote && (
            <PropField label="Note text" hint="Static annotation rendered on the document. Recipient sees it; not a contract field.">
              <textarea
                value={f.noteText ?? ''}
                onChange={(e) => props.onUpdateField(f.id, { noteText: e.currentTarget.value || undefined })}
                rows={3}
                placeholder="e.g. Initial each page where you see this note."
                className="w-full px-2.5 py-2 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
              />
            </PropField>
          )}

          {isFormula && (
            <FormulaSection
              field={f}
              allFields={props.allFields}
              recipients={props.recipients}
              onUpdate={(patch) => props.onUpdateField(f.id, patch)}
            />
          )}

          {isSelection && (
            <>
              <PropField label="Options" hint="One option per line. Recipients pick exactly one.">
                <textarea
                  value={(f.options ?? []).join('\n')}
                  onChange={(e) => {
                    const opts = e.currentTarget.value
                      .split(/\r?\n/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                    props.onUpdateField(f.id, { options: opts.length ? opts : undefined });
                  }}
                  rows={4}
                  placeholder={'Approved\nDeclined\nNeeds revision'}
                  className="w-full px-2.5 py-2 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
                />
              </PropField>
              <PropField label="Default option" hint="Optional. Must match one of the options above.">
                <input
                  type="text"
                  value={f.defaultValue ?? ''}
                  onChange={(e) => props.onUpdateField(f.id, { defaultValue: e.currentTarget.value || undefined })}
                  placeholder="(none)"
                  className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
              </PropField>
              <PropField label="Data label" hint="Machine-readable name for export.">
                <input
                  type="text"
                  value={f.dataLabel ?? ''}
                  onChange={(e) => props.onUpdateField(f.id, { dataLabel: e.currentTarget.value || undefined })}
                  placeholder="e.g. review_status"
                  className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] font-mono text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
              </PropField>
            </>
          )}

          {isText && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] text-ink">Read-only</span>
                <ToggleSwitch checked={!!f.readOnly} onChange={() => props.onUpdateField(f.id, { readOnly: !f.readOnly })} />
              </div>
              <PropField label="Default value" hint="Pre-filled when the recipient opens the document.">
                <input
                  type="text"
                  value={f.defaultValue ?? ''}
                  onChange={(e) => props.onUpdateField(f.id, { defaultValue: e.currentTarget.value || undefined })}
                  placeholder={isNumeric ? 'e.g. 100' : ''}
                  className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
              </PropField>
              <PropField label="Character limit">
                <input
                  type="number"
                  min={1}
                  value={f.charLimit ?? ''}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    props.onUpdateField(f.id, { charLimit: v ? Math.max(1, Number(v)) : undefined });
                  }}
                  placeholder="No limit"
                  className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
              </PropField>
              {isNumeric && (
                <div className="grid grid-cols-2 gap-2">
                  <PropField label="Min">
                    <input
                      type="number"
                      value={f.min ?? ''}
                      onChange={(e) => {
                        const v = e.currentTarget.value;
                        props.onUpdateField(f.id, { min: v === '' ? undefined : Number(v) });
                      }}
                      className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                    />
                  </PropField>
                  <PropField label="Max">
                    <input
                      type="number"
                      value={f.max ?? ''}
                      onChange={(e) => {
                        const v = e.currentTarget.value;
                        props.onUpdateField(f.id, { max: v === '' ? undefined : Number(v) });
                      }}
                      className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                    />
                  </PropField>
                </div>
              )}
              <PropField label="Validation pattern" hint="Regular expression. Recipient input must match.">
                <input
                  type="text"
                  value={f.pattern ?? ''}
                  onChange={(e) => props.onUpdateField(f.id, { pattern: e.currentTarget.value || undefined })}
                  placeholder="e.g. ^\\d{9}$"
                  className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] font-mono text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
              </PropField>
              {f.pattern && (
                <PropField label="Validation message" hint="Shown when the value doesn't match the pattern.">
                  <input
                    type="text"
                    value={f.patternMessage ?? ''}
                    onChange={(e) => props.onUpdateField(f.id, { patternMessage: e.currentTarget.value || undefined })}
                    placeholder="e.g. Must be a 9-digit UM ID"
                    className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                  />
                </PropField>
              )}
              <PropField label="Data label" hint="Machine-readable name for export.">
                <input
                  type="text"
                  value={f.dataLabel ?? ''}
                  onChange={(e) => props.onUpdateField(f.id, { dataLabel: e.currentTarget.value || undefined })}
                  placeholder="e.g. employee_id"
                  className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] font-mono text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
                />
              </PropField>
            </>
          )}

          <ConditionalLogicSection
            field={f}
            allFields={props.allFields}
            recipients={props.recipients}
            onUpdateField={props.onUpdateField}
          />

          <div className="text-[11px] text-ink-tertiary pt-1 border-t border-hairline">
            Page {f.page} · ({(f.x * 100).toFixed(0)}%, {(f.y * 100).toFixed(0)}%)
          </div>
        </div>
        <button
          type="button"
          onClick={() => props.onRemoveField(f.id)}
          className="mt-6 w-full inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-status-declined-border text-[13px] font-medium text-status-declined hover:bg-status-declined-bg"
        >
          <Trash /> Remove field
        </button>
      </aside>
    );
  }

  if (props.armedType) {
    return (
      <aside className="bg-surface border-l border-hairline overflow-y-auto p-5">
        <div className="rounded-md border border-accent/20 bg-accent-soft/50 p-3">
          <p className="text-[13px] font-medium text-ink">Click on the document</p>
          <p className="mt-1 text-[12px] text-ink-secondary">
            Click anywhere on the document to place a {FIELD_DEFAULTS[props.armedType].label} field, or just drag the tile from the left rail.
          </p>
          <button
            type="button"
            onClick={props.onCancelArm}
            className="mt-3 inline-flex h-7 items-center px-2 rounded-md text-[12px] text-ink-secondary hover:bg-surface-muted/60"
          >
            Cancel
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="bg-surface border-l border-hairline overflow-y-auto p-5">
      <div>
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-surface-muted text-ink-secondary">
          <PenIcon />
        </span>
        <h3 className="mt-3 text-[14px] font-semibold text-ink">Select a field</h3>
        <p className="mt-1 text-[12.5px] text-ink-secondary">Click a field on the document to edit its properties.</p>
      </div>
      <div className="mt-6 pt-5 border-t border-hairline">
        <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Quick tips</h4>
        <ul className="mt-2 space-y-2.5">
          <Tip>Drag a field type from the left rail onto the document.</Tip>
          <Tip>Each field is color-coded to its assigned recipient.</Tip>
          <Tip>Click any placed field to mark required or delete.</Tip>
          <Tip>Use sequential signing to control the order recipients sign.</Tip>
        </ul>
      </div>
    </aside>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[12px] text-ink-secondary leading-snug">
      <span className="mt-1.5 inline-flex h-1 w-1 rounded-full bg-accent flex-shrink-0" />
      <span>{children}</span>
    </li>
  );
}

/**
 * STAMP-only properties: image upload (PNG/JPEG, ≤200KB). The bytes are
 * base64-encoded client-side and stored in the field's meta — no separate
 * upload pipeline needed for v1. Recipient sees the stamp as static; seal
 * embeds it via pdf-lib drawImage.
 */
function StampSection({
  field, onUpdate,
}: {
  field: FieldDef;
  onUpdate: (patch: Partial<FieldDef>) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dataUrl = field.stampImageBase64 && field.stampMimeType
    ? `data:${field.stampMimeType};base64,${field.stampImageBase64}`
    : null;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    if (file.size > 200 * 1024) {
      setError('Stamp image must be under 200 KB.');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Stamp must be PNG, JPEG, or WebP.');
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.replace(/^data:image\/[a-z+]+;base64,/, '');
      onUpdate({ stampImageBase64: base64, stampMimeType: file.type });
    };
    reader.readAsDataURL(file);
  }

  return (
    <PropField label="Stamp image" hint="PNG, JPEG, or WebP. Max 200 KB. Sender-uploaded; recipient sees it as static.">
      <div className="space-y-2">
        {dataUrl ? (
          <div className="rounded-md border border-hairline bg-surface-muted/30 p-3 flex items-center gap-3">
            <img src={dataUrl} alt="Stamp preview" className="max-h-16 max-w-[120px] object-contain" />
            <button
              type="button"
              onClick={() => onUpdate({ stampImageBase64: undefined, stampMimeType: undefined })}
              className="text-[11.5px] text-ink-tertiary hover:text-status-declined"
            >
              Remove
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-ink-tertiary">No image uploaded yet.</p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onFile}
          className="text-[12px] text-ink file:inline-flex file:h-8 file:items-center file:px-3 file:rounded-md file:border file:border-hairline file:bg-surface file:text-[12px] file:font-medium file:text-ink hover:file:bg-surface-muted/60 file:mr-2"
        />
        {error && <p className="text-[11.5px] text-status-declined">{error}</p>}
      </div>
    </PropField>
  );
}

/**
 * FORMULA-only properties: the expression itself + a click-to-insert helper
 * listing every NUMBER field in the envelope. Reference syntax inserts the
 * source field's `dataLabel` if set, otherwise the field's clientId — both
 * are remapped to the source field's DB id by the server action so the
 * stored expression resolves correctly at signing time.
 */
function FormulaSection({
  field, allFields, recipients, onUpdate,
}: {
  field: FieldDef;
  allFields: FieldDef[];
  recipients: RecipientDef[];
  onUpdate: (patch: Partial<FieldDef>) => void;
}) {
  const refCandidates = allFields.filter(
    (f) => f.id !== field.id && (f.type === 'NUMBER' || f.type === 'TEXT'),
  );
  const formula = field.formula ?? '';

  function insertRef(refKey: string) {
    const token = `{${refKey}}`;
    const next = formula ? `${formula} + ${token}` : token;
    onUpdate({ formula: next });
  }

  return (
    <>
      <PropField label="Formula" hint="Math over numeric refs. Use {label} to reference another field.">
        <textarea
          value={formula}
          onChange={(e) => onUpdate({ formula: e.currentTarget.value || undefined })}
          rows={3}
          placeholder="{quantity} * {price}"
          className="w-full px-2.5 py-2 rounded-md bg-surface border border-hairline text-[12.5px] font-mono text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 resize-none"
        />
      </PropField>
      {refCandidates.length > 0 && (
        <div>
          <span className="block text-[11px] font-medium text-ink-secondary mb-1">Insert reference</span>
          <div className="flex flex-wrap gap-1">
            {refCandidates.map((c) => {
              const ridx = recipients.findIndex((r) => r.clientId === c.recipientClientId);
              const rname = ridx >= 0 ? recipients[ridx]!.name || `R${ridx + 1}` : '?';
              const refKey = c.dataLabel?.trim() || c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => insertRef(refKey)}
                  title={`Insert {${refKey}} — ${FIELD_DEFAULTS[c.type].label} for ${rname}`}
                  className="inline-flex h-6 items-center px-2 rounded border border-hairline bg-surface text-[10.5px] font-mono text-ink hover:bg-surface-muted/60"
                >
                  {refKey.length > 18 ? refKey.slice(0, 16) + '…' : refKey}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[10.5px] text-ink-tertiary">
            Tip: set a <span className="font-mono">Data label</span> on each source field for readable refs.
          </p>
        </div>
      )}
    </>
  );
}

/**
 * Per-recipient "route to me only when X equals Y" rule. Source must be a
 * field belonging to an earlier recipient (otherwise the rule could never
 * be evaluated). When unmet at routing time, the recipient is marked
 * SKIPPED in the audit chain and the envelope advances past them.
 */
function RecipientRoutingEditor({
  recipient, earlierFields, earlierRecipients, onUpdate,
}: {
  recipient: RecipientDef;
  earlierFields: FieldDef[];
  earlierRecipients: RecipientDef[];
  onUpdate: (patch: Partial<RecipientDef>) => void;
}) {
  const cond = recipient.condition;
  const candidates = earlierFields.filter(
    (f) => f.type !== 'SIGNATURE' && f.type !== 'INITIALS',
  );
  const source = cond ? candidates.find((c) => c.id === cond.whenFieldId) : null;
  // Auto-expand if a rule already exists, so editing an existing envelope
  // doesn't hide the configured rule behind the disclosure.
  const [expanded, setExpanded] = useState(!!cond);

  function setSource(id: string) {
    if (!id) {
      onUpdate({ condition: undefined });
      return;
    }
    onUpdate({ condition: { whenFieldId: id, equals: cond?.equals ?? '' } });
  }
  function setEquals(v: string) {
    if (!cond) return;
    onUpdate({ condition: { whenFieldId: cond.whenFieldId, equals: v } });
  }
  function clear() {
    onUpdate({ condition: undefined });
    setExpanded(false);
  }

  return (
    <div className="mt-1.5 ml-7">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-ink-tertiary hover:text-ink hover:bg-surface-muted/60 transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>Conditional routing</span>
        {cond && (
          <span className="ml-1 inline-flex h-3.5 px-1 rounded-full bg-accent-soft text-accent text-[9.5px] font-semibold items-center">
            ON
          </span>
        )}
      </button>
      {expanded && (
        candidates.length === 0 ? (
          <div className="mt-1.5 px-2.5 py-2 text-[11px] text-ink-tertiary leading-snug rounded-md border border-dashed border-hairline bg-surface-muted/30">
            Place at least one non-signature field on an earlier recipient — that field's value becomes the trigger for this rule.
          </div>
        ) : (
          <div className="mt-1.5 px-2.5 py-2 rounded-md border border-hairline bg-surface-muted/30 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] font-medium text-ink-secondary leading-snug">
                Skip this recipient unless an earlier field has a chosen value.
              </span>
              {cond && (
                <button type="button" onClick={clear} className="text-[10.5px] text-ink-tertiary hover:text-status-declined">
                  Clear
                </button>
              )}
            </div>
            <PropField label="Route to this recipient when…" hint="Otherwise they will be skipped.">
              <Select
                value={cond?.whenFieldId ?? ''}
                onChange={setSource}
                ariaLabel="Route condition source field"
                options={[
                  { value: '', label: '— Always route —' },
                  ...candidates.map((c) => {
                    const ridx = earlierRecipients.findIndex((r) => r.clientId === c.recipientClientId);
                    const rname = ridx >= 0 ? earlierRecipients[ridx]!.name || `Recipient ${ridx + 1}` : '?';
                    return {
                      value: c.id,
                      label: `${FIELD_DEFAULTS[c.type].label} · ${rname} · p${c.page}`,
                    };
                  }),
                ]}
              />
            </PropField>
            {source && (
              <PropField label="…equals">
                <ConditionEqualsControl
                  source={source}
                  value={cond?.equals ?? ''}
                  onChange={setEquals}
                />
              </PropField>
            )}
          </div>
        )
      )}
    </div>
  );
}

/**
 * Per-field "show only when X equals Y" conditional logic. Lists every
 * other placed field as a possible source. The value picker adapts to the
 * source type (CHECKBOX → checked/unchecked; DROPDOWN/RADIO → option select;
 * everything else → free text).
 */
function ConditionalLogicSection({
  field, allFields, recipients, onUpdateField,
}: {
  field: FieldDef;
  allFields: FieldDef[];
  recipients: RecipientDef[];
  onUpdateField: (id: string, patch: Partial<FieldDef>) => void;
}) {
  const candidates = allFields.filter(
    (f) => f.id !== field.id && f.type !== 'SIGNATURE' && f.type !== 'INITIALS',
  );
  const cond = field.condition;
  const source = cond ? candidates.find((c) => c.id === cond.whenFieldId) : null;
  const enabled = !!cond;

  function setSource(srcId: string) {
    if (!srcId) {
      onUpdateField(field.id, { condition: undefined });
      return;
    }
    onUpdateField(field.id, {
      condition: { whenFieldId: srcId, equals: cond?.equals ?? '' },
    });
  }
  function setEquals(v: string) {
    if (!cond) return;
    onUpdateField(field.id, { condition: { whenFieldId: cond.whenFieldId, equals: v } });
  }
  function clear() {
    onUpdateField(field.id, { condition: undefined });
  }

  if (candidates.length === 0) return null;

  return (
    <div className="pt-2 border-t border-hairline space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] font-medium text-ink-secondary uppercase tracking-[0.06em]">
          Conditional logic
        </span>
        {enabled && (
          <button type="button" onClick={clear} className="text-[11px] text-ink-tertiary hover:text-status-declined">
            Clear
          </button>
        )}
      </div>
      <PropField label="Show this field when…" hint="Field is hidden until the source matches.">
        <Select
          value={cond?.whenFieldId ?? ''}
          onChange={setSource}
          ariaLabel="Conditional source field"
          options={[
            { value: '', label: '— Always show —' },
            ...candidates.map((c) => {
              const ridx = recipients.findIndex((r) => r.clientId === c.recipientClientId);
              const rname = ridx >= 0 ? recipients[ridx]!.name || `Recipient ${ridx + 1}` : '?';
              return {
                value: c.id,
                label: `${FIELD_DEFAULTS[c.type].label} · ${rname} · p${c.page}`,
              };
            }),
          ]}
        />
      </PropField>
      {source && (
        <PropField label="…equals" hint={equalsHint(source)}>
          <ConditionEqualsControl
            source={source}
            value={cond?.equals ?? ''}
            onChange={setEquals}
          />
        </PropField>
      )}
    </div>
  );
}

function equalsHint(source: FieldDef): string {
  switch (source.type) {
    case 'CHECKBOX':  return 'Checked or unchecked.';
    case 'DROPDOWN':
    case 'RADIO':     return 'Pick one of the source field’s options.';
    default:          return 'Recipient input must match this exactly.';
  }
}

function ConditionEqualsControl({
  source, value, onChange,
}: { source: FieldDef; value: string; onChange: (v: string) => void }) {
  if (source.type === 'CHECKBOX') {
    return (
      <Select
        value={value}
        onChange={onChange}
        ariaLabel="Match value"
        options={[
          { value: '',      label: '— Choose —' },
          { value: 'true',  label: 'Checked' },
          { value: 'false', label: 'Unchecked' },
        ]}
      />
    );
  }
  if ((source.type === 'DROPDOWN' || source.type === 'RADIO') && source.options && source.options.length > 0) {
    return (
      <Select
        value={value}
        onChange={onChange}
        ariaLabel="Match value"
        options={[
          { value: '', label: '— Choose —' },
          ...source.options.map((o) => ({ value: o, label: o })),
        ]}
      />
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder="Exact value"
      className="w-full h-8 px-2.5 rounded-md bg-surface border border-hairline text-[12.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
    />
  );
}

function PropField({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11.5px] font-medium text-ink-secondary mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[10.5px] text-ink-tertiary mt-1 leading-snug">{hint}</span>}
    </label>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="relative inline-flex h-5 w-9 flex-shrink-0">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} className="peer sr-only" />
      <span className={`absolute inset-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-muted'}`} />
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Add recipient modal
   ═══════════════════════════════════════════════════════════════ */
function AddRecipientModal({
  existing, onCancel, onAdd,
}: {
  existing: RecipientDef[];
  onCancel: () => void;
  onAdd: (name: string, email: string, role: 'SIGNER' | 'CC' | 'APPROVER' | 'WITNESS' | 'IN_PERSON_SIGNER') => void;
}) {
  useEscape(onCancel);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'SIGNER' | 'CC' | 'APPROVER' | 'WITNESS' | 'IN_PERSON_SIGNER'>('SIGNER');
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    const n = name.trim();
    const ee = email.trim().toLowerCase();
    if (!n) { setErr('Name is required.'); return; }
    if (!/\S+@\S+\.\S+/.test(ee)) { setErr('Enter a valid email.'); return; }
    if (existing.some((r) => r.email.toLowerCase() === ee)) {
      setErr('Already added.'); return;
    }
    onAdd(n, ee, role);
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="add-rcpt-title" className="fixed inset-0 z-50 bg-canvas/40 backdrop-blur-sm flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-[460px] rounded-lg border border-hairline bg-surface shadow-[0_24px_48px_rgba(15,17,21,0.18)]">
        <div className="px-5 pt-5 pb-3 border-b border-hairline">
          <h2 id="add-rcpt-title" className="text-[16px] font-semibold text-ink">Add recipient</h2>
          <p className="mt-1 text-[12.5px] text-ink-secondary">Specify who should sign or receive this document.</p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Maria Chen"
              className="h-9 px-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
              onKeyDown={(e) => { if (e.key === 'Enter') submit(e); }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="maria@example.com"
              className="h-9 px-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
              onKeyDown={(e) => { if (e.key === 'Enter') submit(e); }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">Role</span>
            <Select
              value={role}
              onChange={(v) => setRole(v as 'SIGNER' | 'CC' | 'APPROVER' | 'WITNESS' | 'IN_PERSON_SIGNER')}
              ariaLabel="Recipient role"
              options={[
                { value: 'SIGNER', label: 'Needs to sign', hint: 'Standard signer with required fields.' },
                { value: 'WITNESS', label: 'Signs as a witness', hint: 'Legal observer signature.' },
                { value: 'IN_PERSON_SIGNER', label: 'Signs in person', hint: 'Host hands the device over.' },
                { value: 'APPROVER', label: 'Reviews and approves', hint: 'Gates routing, no fields.' },
                { value: 'CC', label: 'Receives a copy (CC)', hint: 'No action required.' },
              ]}
            />
          </label>
          {err && <p className="text-[12px] text-status-declined">{err}</p>}
        </div>
        <div className="px-5 py-3 border-t border-hairline flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="inline-flex h-9 items-center px-3 rounded-md border border-hairline bg-surface text-[13px] font-medium text-ink hover:bg-surface-muted/60">
            Cancel
          </button>
          <button type="button" onClick={submit} className="inline-flex h-9 items-center px-4 rounded-md bg-accent text-white text-[13px] font-medium border border-accent-deep hover:bg-accent-deep">
            Add recipient
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Toast
   ═══════════════════════════════════════════════════════════════ */
function Toast({ kind, text, onClose }: { kind: 'info' | 'error' | 'success'; text: string; onClose: () => void }) {
  const klass = kind === 'error'
    ? 'border-status-declined-border bg-status-declined-bg text-status-declined'
    : kind === 'success'
    ? 'border-status-completed-border bg-status-completed-bg text-status-completed'
    : 'border-hairline bg-surface text-ink';
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-md border ${klass} px-4 py-3 shadow-[0_8px_24px_rgba(15,17,21,0.12)] flex items-start gap-2`}>
      <span className="mt-0.5">
        {kind === 'error' ? <AlertIcon /> : kind === 'success' ? <CheckSm /> : <InfoIcon />}
      </span>
      <p className="flex-1 text-[12.5px] leading-snug">{text}</p>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
        <X />
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Hidden file refs
   ═══════════════════════════════════════════════════════════════ */
function DocumentRefs({ documents }: { documents: DocumentDef[] }) {
  return <>{documents.map((d) => <DocumentRef key={d.clientId} doc={d} />)}</>;
}
function DocumentRef({ doc }: { doc: DocumentDef }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try { const dt = new DataTransfer(); dt.items.add(doc.file); el.files = dt.files; } catch { /* no-op */ }
  }, [doc.file]);
  return <input ref={ref} type="file" name="document" data-client-id={doc.clientId} className="hidden" tabIndex={-1} aria-hidden="true" />;
}

/* ═══════════════════════════════════════════════════════════════
   Helpers + icons
   ═══════════════════════════════════════════════════════════════ */
function clamp01(v: number) { if (Number.isNaN(v)) return 0; return Math.min(1, Math.max(0, v)); }

let _pdfjs: typeof import('pdfjs-dist') | null = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const mod = await import('pdfjs-dist');
  mod.GlobalWorkerOptions.workerSrc = '/DocuRidge/pdf.worker.mjs';
  _pdfjs = mod;
  return mod;
}

function FieldTileIcon({ type }: { type: FieldType }) {
  const props = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 as const, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (type) {
    case 'SIGNATURE': return (<svg {...props}><path d="M3 17l6-6 4 4 8-8" /><path d="M3 21h18" /></svg>);
    case 'INITIALS':  return (<svg {...props}><path d="M4 7V4h16v3" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>);
    case 'DATE':      return (<svg {...props}><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>);
    case 'TEXT':      return (<svg {...props}><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="14" y2="15" /></svg>);
    case 'CHECKBOX':  return (<svg {...props}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>);
    case 'NAME':      return (<svg {...props}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>);
    case 'EMAIL':     return (<svg {...props}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22 6 12 13 2 6" /></svg>);
    case 'JOB_TITLE': return (<svg {...props}><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></svg>);
    case 'NUMBER':    return (<svg {...props}><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></svg>);
    case 'PHONE':     return (<svg {...props}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>);
    case 'ADDRESS':   return (<svg {...props}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>);
    case 'COMPANY':   return (<svg {...props}><path d="M3 21V7l9-4 9 4v14" /><line x1="3" y1="21" x2="21" y2="21" /><line x1="9" y1="9" x2="9" y2="9.01" /><line x1="9" y1="13" x2="9" y2="13.01" /><line x1="9" y1="17" x2="9" y2="17.01" /><line x1="15" y1="9" x2="15" y2="9.01" /><line x1="15" y1="13" x2="15" y2="13.01" /><line x1="15" y1="17" x2="15" y2="17.01" /></svg>);
    case 'DROPDOWN':  return (<svg {...props}><rect x="3" y="6" width="18" height="12" rx="2" /><polyline points="9 11 12 14 15 11" /></svg>);
    case 'RADIO':     return (<svg {...props}><circle cx="6" cy="7" r="2.5" /><line x1="11" y1="7" x2="20" y2="7" /><circle cx="6" cy="13" r="2.5" fill="currentColor" /><line x1="11" y1="13" x2="20" y2="13" /><circle cx="6" cy="19" r="2.5" /><line x1="11" y1="19" x2="20" y2="19" /></svg>);
    case 'FORMULA':   return (<svg {...props}><path d="M6 4l4 16M14 4l4 16" /><line x1="3" y1="12" x2="21" y2="12" /></svg>);
    case 'ATTACHMENT':return (<svg {...props}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>);
    case 'APPROVE':   return (<svg {...props}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>);
    case 'DECLINE':   return (<svg {...props}><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>);
    case 'NOTE':      return (<svg {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></svg>);
    case 'LINE':      return (<svg {...props}><line x1="3" y1="12" x2="21" y2="12" /></svg>);
    case 'STAMP':     return (<svg {...props}><path d="M19 14l-2 4H7l-2-4M5 14h14M9 14V8a3 3 0 1 1 6 0v6" /></svg>);
  }
}

/**
 * Floating toolbar shown above the selected field(s) on a page. Single-select
 * exposes per-field quick actions (required toggle, delete). When 2+ fields
 * are selected, an alignment row appears (left, center-h, right, top,
 * center-v, bottom, distribute H, distribute V) — the operations are pure
 * geometry on the field rectangles, scoped to the selection.
 */
function FieldToolbar({
  fields, onToggleRequired, onUpdateField, onRemove,
}: {
  fields: FieldDef[];
  onToggleRequired: (id: string) => void;
  onUpdateField: (id: string, patch: Partial<FieldDef>) => void;
  onRemove: (id: string) => void;
}) {
  if (fields.length === 0) return null;

  // Anchor toolbar above the topmost-leftmost selected field.
  const topField = fields.reduce((a, b) => (b.y < a.y ? b : a), fields[0]!);

  function alignLeft() {
    const minX = Math.min(...fields.map((f) => f.x));
    fields.forEach((f) => onUpdateField(f.id, { x: minX }));
  }
  function alignRight() {
    const maxRight = Math.max(...fields.map((f) => f.x + f.w));
    fields.forEach((f) => onUpdateField(f.id, { x: clamp01(maxRight - f.w) }));
  }
  function alignTop() {
    const minY = Math.min(...fields.map((f) => f.y));
    fields.forEach((f) => onUpdateField(f.id, { y: minY }));
  }
  function alignBottom() {
    const maxBottom = Math.max(...fields.map((f) => f.y + f.h));
    fields.forEach((f) => onUpdateField(f.id, { y: clamp01(maxBottom - f.h) }));
  }
  function alignCenterH() {
    const cx = (Math.min(...fields.map((f) => f.x)) + Math.max(...fields.map((f) => f.x + f.w))) / 2;
    fields.forEach((f) => onUpdateField(f.id, { x: clamp01(cx - f.w / 2) }));
  }
  function alignCenterV() {
    const cy = (Math.min(...fields.map((f) => f.y)) + Math.max(...fields.map((f) => f.y + f.h))) / 2;
    fields.forEach((f) => onUpdateField(f.id, { y: clamp01(cy - f.h / 2) }));
  }
  function distributeH() {
    if (fields.length < 3) return;
    const sorted = [...fields].sort((a, b) => a.x - b.x);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const totalW = last.x - first.x;
    const step = totalW / (sorted.length - 1);
    sorted.forEach((f, i) => onUpdateField(f.id, { x: clamp01(first.x + step * i) }));
  }
  function distributeV() {
    if (fields.length < 3) return;
    const sorted = [...fields].sort((a, b) => a.y - b.y);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const totalH = last.y - first.y;
    const step = totalH / (sorted.length - 1);
    sorted.forEach((f, i) => onUpdateField(f.id, { y: clamp01(first.y + step * i) }));
  }

  const isMulti = fields.length > 1;
  const allRequired = fields.every((f) => f.required);
  function toggleAllRequired() {
    fields.forEach((f) => {
      // Only flip the ones not already in the new state.
      if (f.required === allRequired) onToggleRequired(f.id);
    });
  }
  function removeAll() {
    fields.forEach((f) => onRemove(f.id));
  }

  return (
    <div
      role="toolbar"
      aria-label={`Field actions${isMulti ? ` for ${fields.length} fields` : ''}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        // Anchor: just above the topmost selected field. Push down 4px below
        // top edge if the field sits at the very top of the page.
        left: `${topField.x * 100}%`,
        top: `calc(${topField.y * 100}% - 36px)`,
        // If anchored above the page, clamp to inside.
        transform: topField.y < 0.04 ? `translateY(${(0.04 - topField.y) * 100}%)` : undefined,
        zIndex: 30,
      }}
      className="inline-flex items-center gap-0.5 rounded-md bg-canvas text-white border border-canvas-line shadow-[0_8px_24px_rgba(15,17,21,0.18)] px-1 py-0.5"
    >
      {isMulti && (
        <span className="px-2 text-[11px] font-mono text-white/80 border-r border-canvas-line mr-0.5">
          {fields.length} selected
        </span>
      )}
      <ToolbarButton label={allRequired ? 'Make all optional' : 'Make all required'} onClick={toggleAllRequired}>
        {allRequired
          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /></svg>
          : <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="4" /></svg>}
      </ToolbarButton>

      {isMulti && (
        <>
          <span className="h-4 w-px bg-canvas-line mx-0.5" aria-hidden="true" />
          <ToolbarButton label="Align left" onClick={alignLeft}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="4" x2="4" y2="20" /><rect x="6" y="6" width="10" height="4" /><rect x="6" y="14" width="14" height="4" /></svg>
          </ToolbarButton>
          <ToolbarButton label="Align center horizontally" onClick={alignCenterH}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="4" x2="12" y2="20" /><rect x="7" y="6" width="10" height="4" /><rect x="5" y="14" width="14" height="4" /></svg>
          </ToolbarButton>
          <ToolbarButton label="Align right" onClick={alignRight}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="20" y1="4" x2="20" y2="20" /><rect x="8" y="6" width="10" height="4" /><rect x="4" y="14" width="14" height="4" /></svg>
          </ToolbarButton>
          <span className="h-4 w-px bg-canvas-line mx-0.5" aria-hidden="true" />
          <ToolbarButton label="Align top" onClick={alignTop}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="4" x2="20" y2="4" /><rect x="6" y="6" width="4" height="10" /><rect x="14" y="6" width="4" height="14" /></svg>
          </ToolbarButton>
          <ToolbarButton label="Align center vertically" onClick={alignCenterV}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="12" x2="20" y2="12" /><rect x="6" y="7" width="4" height="10" /><rect x="14" y="5" width="4" height="14" /></svg>
          </ToolbarButton>
          <ToolbarButton label="Align bottom" onClick={alignBottom}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="20" x2="20" y2="20" /><rect x="6" y="8" width="4" height="10" /><rect x="14" y="4" width="4" height="14" /></svg>
          </ToolbarButton>
          {fields.length >= 3 && (
            <>
              <span className="h-4 w-px bg-canvas-line mx-0.5" aria-hidden="true" />
              <ToolbarButton label="Distribute horizontally" onClick={distributeH}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="4" x2="4" y2="20" /><line x1="20" y1="4" x2="20" y2="20" /><rect x="10" y="8" width="4" height="8" /></svg>
              </ToolbarButton>
              <ToolbarButton label="Distribute vertically" onClick={distributeV}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="4" x2="20" y2="4" /><line x1="4" y1="20" x2="20" y2="20" /><rect x="8" y="10" width="8" height="4" /></svg>
              </ToolbarButton>
            </>
          )}
        </>
      )}

      <span className="h-4 w-px bg-canvas-line mx-0.5" aria-hidden="true" />
      <ToolbarButton label={isMulti ? 'Delete all' : 'Delete'} onClick={removeAll} danger>
        <Trash />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label, onClick, children, danger,
}: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors text-white/90 ${
        danger ? 'hover:bg-status-declined/40 hover:text-white' : 'hover:bg-canvas-line hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function ChevronDown() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>); }
function SparkleIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>); }
function ChevronLeft() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>); }
function ArrowRight() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>); }
function Plus() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>); }
function X() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>); }
function UploadIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>); }
function FileIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>); }
function SaveIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>); }
function SendIconSm() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>); }
function PenIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /></svg>); }
function Trash() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></svg>); }
function AlertIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>); }
function CheckSm() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>); }
function InfoIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>); }
