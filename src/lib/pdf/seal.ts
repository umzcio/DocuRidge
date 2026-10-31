import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PDFContext } from 'pdf-lib';
import { prisma } from '../prisma';
import { CanonicalIntegrityError, CanonicalUnavailableError, readCanonicalPdf, stageSealedPdf } from '../storage';
import { CanonicalSealSourceError } from './seal-errors';
import {
  canonicalJson,
  commitWithEnvelopeEvents,
  prepareEnvelopeEvent,
  type AppendedEnvelopeEvent,
  type PreparedEnvelopeEvent,
} from '../audit/envelope';
import { sha256Hex } from '../util';
import { childLogger } from '../logger';
import { getOrCreateOrgKey, signHex } from '../crypto/org-key';
import { PdfWorkerError, runPdfJob } from '../pdf-worker/runner';
import { CanonicalRefusedError, ensureCanonicalDocument, type CanonicalDocument } from './canonical-source';
import { CURRENT_SEALED_CONTENT_DIGEST_VERSION, type SealedContentDigest } from './content-digest';
import { QpdfMissingError } from './decrypt';
import { PdfComplexityError, assertEnvelopeItemCount, getEnvelopeSealLimits } from './seal-limits';
import { getSealImagePixelLimit } from '../signing/signature-image';
import type {
  AuditPageData,
  SealJobOutput,
  SealRenderField,
  SealRenderInput,
  SealRenderWarning,
  SealRenderWarningKind,
} from './seal-render';

const log = childLogger({ module: 'pdf-seal' });

/**
 * A sealed document built in memory and not yet stored anywhere: the output
 * of `buildSealedEnvelope`, the input of `persistSealedEnvelope`.
 */
export interface SealedBuild {
  envelopeId: string;
  orgId: string;
  bytes: Buffer;
  sha256: string;
  manifest: Record<string, unknown>;
  manifestSignature: string;
  chainHeadHash: string;
  signedByKeyId: string;
  sourceDocumentCount: number;
  /**
   * The recipients exactly as the manifest and audit page record them, so a
   * caller can check, under the envelope's row lock, that nothing the seal
   * describes changed after the build read it.
   */
  recipients: SealedRecipient[];
  /**
   * Built with `completion`: the `envelope.completed` event the seal ends
   * with, which the completion claim must store exactly as is.
   */
  completionEvent?: PreparedEnvelopeEvent;
}

export interface SealedRecipient {
  id: string;
  name: string;
  email: string;
  role: string;
  signingOrder: number;
  signingStatus: string;
  signedAt: string | null;
}

/** PDF worker limits for one build, tighter than the configured defaults. */
export interface SealWorkerLimits {
  /** Job wall-clock limit (default PDF_JOB_TIMEOUT_SEAL_MS). */
  timeoutMs?: number;
  /** Longest wait for a free worker (default PDF_WORKER_QUEUE_MS). */
  queueMs?: number;
}

/**
 * Build an envelope's sealed PDF, without side effects.
 *
 *   - Copies the pages of each document's canonical copy (canonical-source.ts:
 *     the file its signers were shown) into a single output PDF, in the
 *     order the user uploaded them, stamps fields onto each, then appends a
 *     human-readable audit page and embeds a signed JSON manifest as a PDF
 *     attachment. A document with no canonical copy yet is canonicalized
 *     first (see `canonicalSealSource`).
 *   - Document hashes (the SHA-256 of each uploaded file and of its
 *     canonical copy) are recorded in the manifest, plus the chain head, so
 *     a verifier can confirm the seal bound the exact inputs. The manifest
 *     also carries a per-page digest of the rendered output (see
 *     content-digest.ts), so a verifier can detect tampering with the sealed
 *     document's body, not just its inputs.
 *
 * The rendering runs in the PDF worker (`'seal'` job, seal-render.ts): this
 * process reads the envelope and its canonical copies, the child parses,
 * copies, stamps and digests them, and asks back exactly once for the
 * manifest, which is built and signed here, so the org key never reaches the
 * process that parses untrusted PDFs. A worker failure (`busy`, `timeout`,
 * `out_of_memory`, `crashed`, `unavailable`) rejects with `PdfWorkerError`.
 *
 * This is the expensive, failure-prone half of sealing (canonicalizing a
 * legacy document, parsing and copying the canonical copies under the
 * seal-limits.ts caps), so it writes nothing of its own: no sealed file, no
 * row, no audit event. (Canonicalizing stores the document's canonical copy,
 * as sending or showing it would have.) Completion runs it BEFORE it
 * claims the envelope and throws the result away if the claim loses; see
 * `persistSealedEnvelope` for the other half.
 *
 * The sealed audit chain always ends with `envelope.completed`. For an
 * envelope that is not completed yet, pass `completion`: the event the claim
 * will record is computed here (hashed and signed after the current chain
 * head, `createdAt` = `completedAt`) and sealed into the manifest, the Events
 * page and the chain head; the claim then stores exactly that event, and
 * only while the chain head is still the one it follows (`completionEvent`).
 * Without `completion` (a COMPLETED envelope), the stored chain already ends
 * with that event, so either path seals identical evidence.
 */
export async function buildSealedEnvelope(args: {
  envelopeId: string;
  completion?: {
    completedAt: Date;
    actor: { ipAddress?: string | null; userAgent?: string | null; actorUserId?: string | null };
  };
  /** Tighter worker limits (completion's fenced attempt, which audit appends wait for). */
  worker?: SealWorkerLimits;
}): Promise<SealedBuild> {
  const env = await prisma.envelope.findUnique({
    where: { id: args.envelopeId },
    include: {
      org: true,
      createdBy: true,
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' }, include: { signatures: true } },
      fields: { include: { attachment: true, recipient: { select: { name: true, email: true } } } },
      auditEvents: { orderBy: { seq: 'asc' } },
    },
  });
  if (!env) throw new Error('Envelope not found for sealing');
  const orgKey = await getOrCreateOrgKey(env.orgId);
  const head = env.auditEvents[env.auditEvents.length - 1];
  const completionEvent = args.completion
    ? await prepareEnvelopeEvent({
        key: orgKey,
        prior: head ? { seq: head.seq, eventHash: head.eventHash } : null,
        createdAt: args.completion.completedAt,
        event: { envelopeId: env.id, type: 'envelope.completed', ...args.completion.actor },
      })
    : undefined;
  const auditEvents = completionEvent ? [...env.auditEvents, completionEvent] : env.auditEvents;
  // What the seal records: the manifest, the Events page and the chain head.
  const sealedEnv = {
    ...env,
    completedAt: args.completion?.completedAt ?? env.completedAt ?? null,
    auditEvents,
  };

  // Refuse an envelope with too many documents before reading any of them
  // (the render checks again, with the per-document and envelope-wide caps).
  assertEnvelopeItemCount(env.items.length);
  const { input, documents } = await sealRenderInput(sealedEnv);
  const signer = manifestSigner(sealedEnv, orgKey, documents);
  let output: unknown;
  try {
    output = await runPdfJob('seal', input, { ...args.worker, onRequest: signer.onRequest });
  } catch (err) {
    throw signer.failure(err);
  }
  const signed = signer.result();
  const result = signed ? parseSealJobOutput(output, input, env.id) : null;
  if (!signed || !result) {
    throw workerProtocolError(env.id, signed ? 'malformed seal job output' : 'the seal job finished without a signed manifest');
  }
  // The file must carry exactly the manifest this process signed, as the
  // attachment stream pdf-lib writes for it. Checked on the bytes, without
  // parsing them here.
  if (!containsAttachedManifest(result.bytes, signed.manifestBytes)) {
    log.error(
      { envelopeId: env.id, manifestSha256: signed.manifest.manifestSha256, bytes: result.bytes.byteLength },
      'sealed PDF from the worker does not carry the signed manifest',
    );
    throw new PdfWorkerError('crashed');
  }
  for (const warning of result.warnings) {
    log.error({ envelopeId: env.id, recipientId: warning.recipientId, fieldType: warning.fieldType }, WARNING_MESSAGES[warning.kind]);
  }

  const bytes = Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  return {
    envelopeId: env.id,
    orgId: env.orgId,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    manifest: signed.manifest,
    manifestSignature: signed.manifestSignature,
    chainHeadHash: auditEvents[auditEvents.length - 1]?.eventHash ?? '0'.repeat(64),
    completionEvent,
    signedByKeyId: orgKey.keyId,
    sourceDocumentCount: env.items.length,
    recipients: signed.recipients,
  };
}

/** The parts of the loaded envelope the render input is made from. */
interface SealSource {
  id: string;
  title: string;
  org: { name: string; defaultFieldFont?: string | null } | null;
  createdBy: { name: string | null; email: string | null } | null;
  items: Array<{ id: string; title: string; documentFileId: string; documentFile: { sha256: string } }>;
  recipients: Array<{
    id: string; name: string; email: string; signingStatus: string; signedAt: Date | null;
    signatures: Array<{ imagePngBase64: string | null; typedSignature: string | null; fieldId: string | null }>;
  }>;
  fields: Array<{
    id: string; type: string; envelopeItemId: string; page: number; recipientId: string;
    x: { toString(): string } | number; y: { toString(): string } | number;
    w: { toString(): string } | number; h: { toString(): string } | number;
    value: string | null; meta?: unknown;
    recipient: { name: string } | null;
    attachment: { filename: string; sha256: string; sizeBytes: number } | null;
  }>;
  auditEvents: Array<{ createdAt: Date; type: string; actorEmail: string | null; actorName: string | null }>;
}

/**
 * One item's canonical copy, made now if its row has none
 * (`ensureCanonicalDocument`), and the copy's bytes, read from storage and
 * checked against the row.
 *
 * A document the canonicalizer refuses, or whose copy is missing or is not
 * the bytes its row names, fails the seal as a document to replace:
 * `CanonicalSealSourceError` (a SealedContentStructureError) naming it,
 * which completion records as not retryable, with the title in the sender's
 * text. Never anything else in its place: the uploaded
 * original is not sealed. A busy, unavailable or crashed worker propagates as
 * `PdfWorkerError`, which completion leaves retryable; so does a missing qpdf
 * (a legacy encrypted upload), as `unavailable`: the deployment's fault, not
 * the document's.
 */
async function canonicalSealSource(item: SealSource['items'][number]): Promise<{ document: CanonicalDocument; bytes: Buffer }> {
  try {
    const document = await ensureCanonicalDocument(item.documentFileId);
    return { document, bytes: await readCanonicalPdf(document) };
  } catch (err) {
    if (err instanceof CanonicalIntegrityError) {
      log.error({ documentFileId: item.documentFileId }, 'canonical copy does not match its record');
    }
    if (err instanceof CanonicalRefusedError || err instanceof CanonicalUnavailableError) {
      throw new CanonicalSealSourceError(item.title);
    }
    if (err instanceof QpdfMissingError) throw new PdfWorkerError('unavailable');
    throw err;
  }
}

/**
 * The `'seal'` job input: each document's canonical copy read from storage
 * (the child cannot read files) and plain copies of the rows the render
 * draws from, plus the canonical copies, in item order, for the manifest.
 * The IPC clone drops prototypes, so Prisma `Decimal` coordinates become
 * numbers here; Dates survive it.
 */
async function sealRenderInput(env: SealSource): Promise<{ input: SealRenderInput; documents: CanonicalDocument[] }> {
  const documents: CanonicalDocument[] = [];
  const items: SealRenderInput['items'] = [];
  for (const item of env.items) {
    const { document, bytes } = await canonicalSealSource(item);
    documents.push(document);
    items.push({
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      fields: env.fields.filter((f) => f.envelopeItemId === item.id).map(renderField),
    });
  }
  const fieldsById: Record<string, { type: string }> = {};
  for (const f of env.fields) fieldsById[f.id] = { type: f.type };
  const fontKey = env.org?.defaultFieldFont;
  const auditPage: AuditPageData = {
    id: env.id,
    title: env.title,
    createdBy: env.createdBy ? { name: env.createdBy.name ?? null, email: env.createdBy.email ?? null } : null,
    org: env.org ? { name: env.org.name } : null,
    items: env.items.map((it, i) => ({
      title: it.title, documentFile: { sha256: it.documentFile.sha256 }, canonicalSha256: documents[i]!.sha256,
    })),
    recipients: env.recipients.map((r) => ({
      name: r.name, email: r.email, signingStatus: r.signingStatus, signedAt: r.signedAt ?? null,
    })),
    fields: env.fields
      .filter((f) => f.type === 'ATTACHMENT' && f.attachment)
      .map((f) => ({
        type: f.type,
        recipient: f.recipient ? { name: f.recipient.name } : null,
        attachment: { filename: f.attachment!.filename, sha256: f.attachment!.sha256, sizeBytes: f.attachment!.sizeBytes },
      })),
    auditEvents: env.auditEvents.map((e) => ({
      createdAt: e.createdAt, type: e.type, actorEmail: e.actorEmail ?? null, actorName: e.actorName ?? null,
    })),
  };
  const input: SealRenderInput = {
    fieldFont: fontKey === 'serif' || fontKey === 'mono' ? fontKey : 'sans',
    items,
    recipients: env.recipients.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      signatures: r.signatures.map((s) => ({
        imagePngBase64: s.imagePngBase64 ?? null,
        typedSignature: s.typedSignature ?? null,
        fieldId: s.fieldId ?? null,
      })),
    })),
    fieldsById,
    auditPage,
  };
  return { input, documents };
}

function renderField(f: SealSource['fields'][number]): SealRenderField {
  return {
    type: f.type,
    page: f.page,
    x: Number(f.x.toString()),
    y: Number(f.y.toString()),
    w: Number(f.w.toString()),
    h: Number(f.h.toString()),
    value: f.value,
    recipientId: f.recipientId,
    meta: f.meta ?? null,
  };
}

type SignedManifest = Record<string, unknown> & { recipients: SealedRecipient[] };

/**
 * The parent's side of the seal job's one question. The child is untrusted
 * (it parses untrusted PDFs), so its request is validated and only the first
 * one is answered; any second request, or a malformed one, fails the job as
 * a crashed worker.
 *
 * Residual risk, accepted: the parent signs the digest the child reports and
 * does not re-parse the file it gets back (that would put the parsing back in
 * this process). A child that had code execution could therefore have a
 * manifest signed over a body that differs from what the database says
 * should have been stamped. That needs code execution inside pdf-lib, which
 * is pure JavaScript; the worker exists to contain resource use and to keep
 * keys and database credentials out of the parsing process, and it does.
 * Two checks narrow it: every signature is logged (envelope, manifest hash,
 * key) before it is handed over, and the returned file must contain the
 * signed manifest's attachment stream byte for byte
 * (`containsAttachedManifest`).
 */
function manifestSigner(
  sealedEnv: { id: string; orgId: string },
  orgKey: Awaited<ReturnType<typeof getOrCreateOrgKey>>,
  documents: readonly CanonicalDocument[],
) {
  let requests = 0;
  let violation: string | null = null;
  let parentFailure: { err: unknown } | null = null;
  let signed: {
    manifest: SignedManifest;
    manifestSignature: string;
    recipients: SealedRecipient[];
    /** The exact bytes handed to the child to attach. */
    manifestBytes: Uint8Array;
  } | null = null;
  return {
    async onRequest(body: unknown): Promise<Uint8Array> {
      requests += 1;
      if (requests > 1) {
        violation = 'a second signing request';
        throw new Error('A seal job gets one signed manifest');
      }
      const sealedContent = parseSigningRequest(body);
      if (!sealedContent) {
        violation = 'a malformed signing request';
        throw new Error('Malformed signing request');
      }
      try {
        // Build + sign the manifest exactly as the in-process sealer did.
        const manifest = await buildManifest(sealedEnv, orgKey, sealedContent, documents);
        const manifestSha = await sha256Hex(canonicalJson({ ...manifest, manifestSha256: undefined, manifestSignature: undefined }));
        const manifestSignature = await signHex(sealedEnv.orgId, manifestSha);
        const signedManifest: SignedManifest = { ...manifest, manifestSha256: manifestSha, manifestSignature };
        const manifestBytes = new TextEncoder().encode(JSON.stringify(signedManifest));
        signed = { manifest: signedManifest, manifestSignature, recipients: manifest.recipients, manifestBytes };
        // Every signature the org key issues is traceable, even one whose
        // sealed file the child then discards.
        log.info(
          { envelopeId: sealedEnv.id, manifestSha256: manifestSha, signedByKeyId: orgKey.keyId },
          'seal manifest signed for the PDF worker',
        );
        // A copy: the IPC send (or an inline handler) must not share the
        // buffer checked against the output.
        return manifestBytes.slice();
      } catch (err) {
        parentFailure = { err };
        throw err;
      }
    },
    /** The error a failed job rejects with. */
    failure(err: unknown): unknown {
      if (violation) return workerProtocolError(undefined, violation);
      if (err instanceof PdfWorkerError) return err;
      // The child saw only a generic message; the real cause is ours.
      if (parentFailure) return parentFailure.err;
      return err;
    },
    /** The signed manifest, once the one valid request was answered. */
    result() {
      return violation ? null : signed;
    },
  };
}

function workerProtocolError(envelopeId: string | undefined, detail: string): PdfWorkerError {
  log.warn({ envelopeId, detail }, 'PDF worker broke the seal job protocol');
  return new PdfWorkerError('crashed');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `value`'s own data properties, when it is a plain object with exactly `keys`; otherwise null. */
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc)) return null;
    out[key] = desc.value;
  }
  return out;
}

/**
 * The child's `{ sealedContent }`, checked against the SealedContentDigest
 * shape: exactly its fields, the current digest version, a page count the
 * envelope caps allow (plus the audit page) and one lowercase SHA-256 hex
 * digest per page. The parent cannot check that the count matches the
 * rendered output without parsing it (see manifestSigner). Returns a fresh
 * copy, or null.
 */
function parseSigningRequest(body: unknown): SealedContentDigest | null {
  const request = exactRecord(body, ['sealedContent']);
  if (!request) return null;
  const sc = exactRecord(request.sealedContent, ['algorithm', 'digestVersion', 'pageCount', 'pageDigests']);
  if (!sc) return null;
  if (sc.algorithm !== 'sha256' || sc.digestVersion !== CURRENT_SEALED_CONTENT_DIGEST_VERSION) return null;
  const pageCount = sc.pageCount;
  if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount)) return null;
  if (pageCount < 1 || pageCount > getEnvelopeSealLimits().maxPages + 1) return null;
  const digests = sc.pageDigests;
  if (!Array.isArray(digests) || digests.length !== pageCount) return null;
  const pageDigests: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const d: unknown = digests[i];
    if (typeof d !== 'string' || !SHA256_HEX.test(d)) return null;
    pageDigests.push(d);
  }
  return { algorithm: 'sha256', digestVersion: CURRENT_SEALED_CONTENT_DIGEST_VERSION, pageCount, pageDigests };
}

const WARNING_MESSAGES: Record<SealRenderWarningKind, string> = {
  signature_image_embed_failed: 'signature image embed failed; fell back to typed signature',
  drawing_image_embed_failed: 'drawing image embed failed; field left blank',
  stamp_image_embed_failed: 'stamp image embed failed; field left blank',
};

/**
 * Whether `pdf` contains the attachment stream pdf-lib writes for
 * `manifestBytes`: `PDFDocument.attach` stores the file through
 * `PDFContext.flateStream`, i.e. pdf-lib's own pako `deflate` with its
 * default options, and both sealed saves write streams as stored. So the
 * same call here yields the exact bytes the file must hold, and finding them
 * shows the attachment is exactly what was signed, without parsing the file.
 */
export function containsAttachedManifest(pdf: Uint8Array, manifestBytes: Uint8Array): boolean {
  const deflated = PDFContext.create().flateStream(manifestBytes).getContents();
  const haystack = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  return haystack.indexOf(Buffer.from(deflated.buffer, deflated.byteOffset, deflated.byteLength)) !== -1;
}

/** Headroom over the envelope caps for what the sealed file adds (xref, fonts, audit page, manifest). */
const SEALED_FILE_HEADROOM_BYTES = 64 * 1024 * 1024;
/** Bytes per image pixel the sealed file may hold (an RGBA image stored uncompressed). */
const SEALED_FILE_BYTES_PER_PIXEL = 4;
/** Bytes per copied object the sealed file may spend on its dictionary and xref entry. */
const SEALED_FILE_BYTES_PER_OBJECT = 64;
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * The largest sealed file the parent accepts from the worker: the envelope's
 * stream-byte cap, plus its image pixel budget at 4 bytes a pixel, plus 64
 * bytes for each object the envelope may copy, plus 64 MiB of headroom.
 */
export function maxSealOutputBytes(): number {
  const envelope = getEnvelopeSealLimits();
  return (
    envelope.maxSealBytes +
    getSealImagePixelLimit() * SEALED_FILE_BYTES_PER_PIXEL +
    envelope.maxSealObjects * SEALED_FILE_BYTES_PER_OBJECT +
    SEALED_FILE_HEADROOM_BYTES
  );
}

/**
 * The child's job output, checked: a non-empty PDF no larger than
 * `maxSealOutputBytes()`, and warnings naming a known kind and a recipient
 * and field type that are in the input. Returns a fresh copy, or null for a
 * malformed output. A file over the size cap is a limit, not a protocol
 * break: it is logged with its size and rejects with
 * `PdfComplexityError('envelope_seal_bytes')`.
 */
export function parseSealJobOutput(output: unknown, input: SealRenderInput, envelopeId?: string): SealJobOutput | null {
  const out = exactRecord(output, ['bytes', 'warnings']);
  if (!out) return null;
  const bytes = out.bytes;
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.byteLength < PDF_HEADER.length) return null;
  if (PDF_HEADER.some((b, i) => bytes[i] !== b)) return null;
  const maxBytes = maxSealOutputBytes();
  if (bytes.byteLength > maxBytes) {
    log.error({ envelopeId, bytes: bytes.byteLength, maxBytes }, 'sealed PDF from the worker is larger than the size cap');
    throw new PdfComplexityError(
      'envelope_seal_bytes',
      `The sealed document is larger than the ${maxBytes}-byte limit for a sealed file`,
    );
  }

  const fields = input.items.flatMap((item) => item.fields);
  const recipientIds = new Set(fields.map((f) => f.recipientId));
  const fieldTypes = new Set(fields.map((f) => f.type));
  const raw = out.warnings;
  if (!Array.isArray(raw) || raw.length > fields.length) return null;
  const warnings: SealRenderWarning[] = [];
  for (const item of raw as unknown[]) {
    const w = exactRecord(item, ['kind', 'recipientId', 'fieldType']);
    if (!w) return null;
    const { kind, recipientId, fieldType } = w;
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(WARNING_MESSAGES, kind)) return null;
    if (typeof recipientId !== 'string' || !recipientIds.has(recipientId)) return null;
    if (typeof fieldType !== 'string' || !fieldTypes.has(fieldType)) return null;
    warnings.push({ kind: kind as SealRenderWarningKind, recipientId, fieldType });
  }
  return { bytes, warnings };
}

/**
 * - `sealed`: this call stored the file, the SealedDocument row and the
 *   `envelope.sealed` event.
 * - `already_sealed`: an earlier or concurrent attempt got there first; this
 *   one stored nothing.
 * - `not_completed`: the envelope is not COMPLETED; nothing was stored.
 */
export type SealPersistOutcome = 'sealed' | 'already_sealed' | 'not_completed';

/**
 * Store a sealed build: the file, its DocumentFile + SealedDocument rows and
 * the `envelope.sealed` event, only for a COMPLETED envelope that has no
 * sealed document yet.
 *
 * Idempotent and safe under concurrency: the transaction takes the envelope's
 * row lock and re-checks for a SealedDocument under it, so of any number of
 * attempts exactly one stores rows and an event and the rest return
 * `already_sealed` (the unique envelopeId on SealedDocument backs this up).
 * The PDF is staged under a unique name first and moved into place only by
 * the attempt holding the lock, so a losing attempt never overwrites the file
 * a committed row describes.
 *
 * `collect` defers the `envelope.sealed` webhook (see commitWithEnvelopeEvents).
 */
export async function persistSealedEnvelope(
  build: SealedBuild,
  options: { collect?: AppendedEnvelopeEvent[] } = {},
): Promise<SealPersistOutcome> {
  const staged = await stageSealedPdf({
    orgId: build.orgId,
    envelopeId: build.envelopeId,
    buffer: build.bytes,
  });
  try {
    const outcome = await commitWithEnvelopeEvents(build.envelopeId, async (tx, record) => {
      const { count } = await tx.envelope.updateMany({
        where: { id: build.envelopeId, status: 'COMPLETED' },
        data: { updatedAt: new Date() },
      });
      if (count === 0) return 'not_completed' as const;
      const existing = await tx.sealedDocument.findUnique({
        where: { envelopeId: build.envelopeId },
        select: { id: true },
      });
      if (existing) return 'already_sealed' as const;

      const sealedFile = await tx.documentFile.create({
        data: {
          orgId: build.orgId,
          storageType: 'LOCAL_FS',
          storagePath: staged.relativePath,
          mimeType: 'application/pdf',
          sizeBytes: staged.sizeBytes,
          sha256: staged.sha256,
          uploadedById: null,
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
        },
      });
      await tx.sealedDocument.create({
        data: {
          envelopeId: build.envelopeId,
          documentFileId: sealedFile.id,
          manifestJson: build.manifest as Prisma.InputJsonValue,
          manifestSignature: build.manifestSignature,
          chainHeadHash: build.chainHeadHash,
          signedByKeyId: build.signedByKeyId,
        },
      });
      await record({
        envelopeId: build.envelopeId,
        type: 'envelope.sealed',
        data: {
          sha256: staged.sha256,
          sizeBytes: staged.sizeBytes,
          sourceDocumentCount: build.sourceDocumentCount,
        },
      });
      // Last, under the lock: if a write above fails, nothing moved; if the
      // commit fails after this, no row describes the file and the next
      // attempt replaces it.
      await staged.commit();
      return 'sealed' as const;
    }, options);
    if (outcome === 'sealed') {
      log.info(
        { envelopeId: build.envelopeId, sha256: staged.sha256, items: build.sourceDocumentCount, keyId: build.signedByKeyId },
        'envelope sealed and signed',
      );
    }
    return outcome;
  } finally {
    await staged.discard();
  }
}

async function buildManifest(
  env: any,
  orgKey: { keyId: string; fingerprint: string; publicKeyPem: string; algorithm: string },
  sealedContent: SealedContentDigest,
  documents: readonly CanonicalDocument[],
) {
  const head = env.auditEvents[env.auditEvents.length - 1];
  const sourceHashes = env.items.map((it: any, i: number) => ({
    itemOrder: it.order,
    title: it.title,
    sourceSha256: it.documentFile.sha256,
    // The canonical copy: what the signers were shown and the seal was built from.
    canonicalSha256: documents[i]!.sha256,
    // The canonical page count: the pages the signers saw and the seal copied.
    pageCount: documents[i]!.pageCount,
  }));
  const recipientSummaries: SealedRecipient[] = env.recipients.map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.recipientRole,
    signingOrder: r.signingOrder,
    signingStatus: r.signingStatus,
    signedAt: r.signedAt?.toISOString() ?? null,
  }));
  const events = env.auditEvents.map((e: any) => ({
    seq: e.seq,
    type: e.type,
    createdAt: e.createdAt.toISOString(),
    actor: { userId: e.actorUserId, recipientId: e.actorRecipientId, email: e.actorEmail, name: e.actorName },
    ipAddress: e.ipAddress,
    userAgent: e.userAgent,
    data: e.data,
    prevHash: e.prevHash,
    eventHash: e.eventHash,
    signature: e.signature,
    signedByKeyId: e.signedByKeyId,
  }));
  return {
    // 3: sealedContent carries digestVersion (see content-digest.ts).
    version: 3,
    generator: 'DocuRidge',
    envelope: {
      id: env.id,
      orgId: env.orgId,
      title: env.title,
      sentAt: env.sentAt?.toISOString() ?? null,
      completedAt: env.completedAt?.toISOString() ?? null,
    },
    signedBy: {
      keyId: orgKey.keyId,
      fingerprint: orgKey.fingerprint,
      algorithm: orgKey.algorithm,
      publicKeyPem: orgKey.publicKeyPem,
    },
    documents: sourceHashes,
    sealedContent,
    recipients: recipientSummaries,
    auditChain: {
      head: head?.eventHash ?? null,
      length: env.auditEvents.length,
      events,
    },
  };
}
