import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { getEnv } from './env';
import { UNREADABLE_MESSAGE, parseInspectResult, type InspectResult } from './pdf/inspect-upload';
import type { PdfSealCost } from './pdf/seal-limits';
import { PdfWorkerError, runPdfJob } from './pdf-worker/runner';

/**
 * Local-FS storage for uploaded PDFs and sealed outputs. Phase 2 wires this
 * into the upload flow; later phases can swap to S3 by replacing this module
 * (consumers depend only on the exported helpers).
 *
 * Paths are constructed as <root>/<orgId>/<sha256>.<ext> — a content-addressed
 * layout, so the same file is never stored twice and the path traversal
 * surface is bounded.
 */

export interface StoredFile {
  storagePath: string;   // absolute path on disk
  relativePath: string;  // org-scoped relative path stored in DB
  sizeBytes: number;
  sha256: string;
  mimeType: string;
}

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

/**
 * Sniff the magic bytes to confirm a buffer is actually a PDF. Header may
 * include a few leading whitespace bytes; we tolerate up to 1024 bytes
 * before the marker (per RFC 8118).
 */
export function sniffPdf(buffer: Buffer): boolean {
  const idx = buffer.indexOf(PDF_MAGIC);
  return idx >= 0 && idx < 1024;
}

/** Run the inspect job; a worker failure becomes the matching upload refusal. */
export async function inspectInWorker(
  bytes: Uint8Array,
  opts: { ignoreEncryption?: boolean } = {},
): Promise<InspectResult> {
  try {
    return parseInspectResult(
      await runPdfJob('inspect', {
        bytes: new Uint8Array(bytes),
        ...(opts.ignoreEncryption ? { ignoreEncryption: true } : {}),
      }),
    );
  } catch (err) {
    if (err instanceof PdfWorkerError) {
      if (err.reason === 'busy' || err.reason === 'unavailable') {
        throw new UploadValidationError(
          'busy',
          'DocuRidge is busy processing other documents. Try again in a minute.',
        );
      }
      return {
        ok: false,
        code: 'pdf_too_complex',
        message:
          'This PDF is too large or complex for DocuRidge to process. Try re-saving or printing it to a new PDF and uploading again.',
      };
    }
    throw err;
  }
}

/**
 * Save a PDF buffer to org-scoped storage. Returns the metadata needed for
 * a `DocumentFile` row. Idempotent — re-uploading the same content reuses
 * the existing file (content-addressed).
 */
export async function saveUploadedPdf(args: {
  orgId: string;
  buffer: Buffer;
  declaredMime: string;
}): Promise<StoredFile & { sealCost: PdfSealCost }> {
  const env = getEnv();
  if (!sniffPdf(args.buffer)) {
    throw new UploadValidationError('not_pdf', 'File does not look like a PDF.');
  }
  if (args.buffer.length > env.MAX_UPLOAD_BYTES) {
    throw new UploadValidationError(
      'too_large',
      `File exceeds size limit of ${args.buffer.length}B vs cap ${env.MAX_UPLOAD_BYTES}B.`,
    );
  }
  // Inspection (parse under the decode ceilings, flatten the form, measure
  // seal cost) runs in the PDF worker: a disposable, capped child process.
  //
  // Encryption: ignoreEncryption=true lets pdf-lib *load* an owner-password
  // PDF, but doesn't decrypt its content streams, so copying those into a new
  // doc produces a "valid" PDF with gibberish pages (sealed output renders
  // blank). When the worker reports `encrypted`, hand the bytes to qpdf here in
  // the parent, which actually decrypts (owner-password PDFs decrypt with no
  // password; user-password PDFs throw QpdfPasswordError), then inspect the
  // decrypted bytes in a second job.
  let workingBuffer = args.buffer;
  let inspected = await inspectInWorker(args.buffer);
  if (!inspected.ok && inspected.code === 'encrypted') {
    const { decryptPdf, QpdfPasswordError } = await import('./pdf/decrypt');
    try {
      workingBuffer = await decryptPdf(args.buffer);
    } catch (decryptErr) {
      if (decryptErr instanceof QpdfPasswordError) {
        throw new UploadValidationError(
          'password_protected',
          'This PDF requires a password to open. Open it in a PDF reader, save a copy without the password, and re-upload.',
        );
      }
      throw new UploadValidationError(
        'unreadable_pdf',
        'Could not decrypt this PDF. Save a copy from your PDF tool without security restrictions and re-upload.',
      );
    }
    inspected = await inspectInWorker(workingBuffer);
  }
  if (!inspected.ok) {
    // Still encrypted after qpdf: treat as unreadable, as the old reload did.
    if (inspected.code === 'encrypted') throw new UploadValidationError('unreadable_pdf', UNREADABLE_MESSAGE);
    throw new UploadValidationError(inspected.code, inspected.message);
  }
  const sealCost: PdfSealCost = inspected.sealCost;
  // From here on, work with the (possibly decrypted) buffer.
  // The hash + storage path is computed from this — re-uploading the same
  // encrypted source gives the same content-addressed path because the
  // decrypted output is byte-identical for a given input.

  const sha256 = createHash('sha256').update(workingBuffer).digest('hex');
  const dir = orgUploadDir(env.UPLOADS_DIR, args.orgId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, `${sha256}.pdf`);
  if (!existsSync(storagePath)) {
    await writeFile(storagePath, workingBuffer, { mode: 0o600 });
  }
  return {
    storagePath,
    relativePath: `${args.orgId}/${sha256}.pdf`,
    sizeBytes: workingBuffer.length,
    sha256,
    mimeType: 'application/pdf',
    sealCost,
  };
}

export async function readPdfFromStorage(relativePath: string): Promise<Buffer> {
  const env = getEnv();
  const root = resolve(env.UPLOADS_DIR);
  const full = resolve(root, relativePath);
  // Path-traversal guard.
  if (!full.startsWith(root + '/')) {
    throw new Error('Invalid storage path');
  }
  return readFile(full);
}

export interface StagedSealedPdf {
  /** Where the sealed PDF lives once committed: `<orgId>/<envelopeId>.pdf`. */
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  /**
   * Atomically move the staged bytes to `relativePath`. Call it only while
   * holding the right to publish this envelope's seal (the persist
   * transaction's row lock, with no SealedDocument row yet), so a concurrent
   * attempt can never replace the file a committed row describes.
   */
  commit(): Promise<void>;
  /** Remove the staged bytes. Idempotent, and a no-op after `commit`. */
  discard(): Promise<void>;
}

const STORAGE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Write a sealed PDF next to its final location under a unique temporary
 * name. Nothing is visible at `<orgId>/<envelopeId>.pdf` until `commit()`, so
 * an attempt that loses the race to persist the seal, or fails before its
 * database rows commit, leaves the published file untouched.
 */
export async function stageSealedPdf(args: {
  orgId: string;
  envelopeId: string;
  buffer: Buffer;
}): Promise<StagedSealedPdf> {
  if (!STORAGE_ID.test(args.orgId) || !STORAGE_ID.test(args.envelopeId)) {
    throw new Error('Invalid sealed storage path');
  }
  const env = getEnv();
  const sha256 = createHash('sha256').update(args.buffer).digest('hex');
  const dir = join(env.SEALED_DIR, args.orgId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${args.envelopeId}.pdf`);
  const stagedPath = join(dir, `.${args.envelopeId}.${randomUUID()}.pdf.partial`);
  await writeFile(stagedPath, args.buffer, { mode: 0o600, flag: 'wx' });
  let staged = true;
  return {
    relativePath: `${args.orgId}/${args.envelopeId}.pdf`,
    sizeBytes: args.buffer.length,
    sha256,
    async commit() {
      await rename(stagedPath, finalPath);
      staged = false;
    },
    async discard() {
      if (!staged) return;
      staged = false;
      await rm(stagedPath, { force: true });
    },
  };
}

export async function readSealedPdf(relativePath: string): Promise<Buffer> {
  const env = getEnv();
  const root = resolve(env.SEALED_DIR);
  const full = resolve(root, relativePath);
  if (!full.startsWith(root + '/')) {
    throw new Error('Invalid sealed path');
  }
  return readFile(full);
}

/**
 * Default MIME allowlist for recipient-uploaded attachments. Senders can
 * override per-field via `meta.allowedMime`. Restricting to common,
 * preview-able formats by default keeps the attack surface narrow —
 * adding e.g. ZIP / executable types is an explicit opt-in.
 */
export const DEFAULT_ATTACHMENT_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;

export class AttachmentValidationError extends Error {
  readonly code: 'mime_not_allowed' | 'too_large' | 'empty';
  constructor(code: 'mime_not_allowed' | 'too_large' | 'empty', message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.code = code;
  }
}

export interface StagedAttachment {
  /** Content-addressed `<orgId>/<sha256>.<ext>`, where `commit` puts the file. */
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  filename: string;
  /** Move the staged bytes to `relativePath` (kept as is if already there). */
  commit(): Promise<void>;
  /** Remove the staged bytes. Idempotent, and a no-op after `commit`. */
  discard(): Promise<void>;
}

/**
 * Validate a recipient-uploaded supporting file and write it under a unique
 * temporary name. The final path is content-addressed (sha256-named), so it
 * may already hold the same bytes for another field; nothing is placed there
 * until the caller, having recorded the FieldAttachment row, calls `commit`.
 * A refused upload is `discard`ed and leaves nothing behind, without ever
 * deleting a file another attachment row may reference.
 */
export async function stageRecipientAttachment(args: {
  orgId: string;
  buffer: Buffer;
  filename: string;
  declaredMime: string;
  /** Optional override of the project default MIME allowlist. */
  allowedMimes?: readonly string[];
  /** Optional override of the per-attachment size cap. */
  maxBytes?: number;
}): Promise<StagedAttachment> {
  const env = getEnv();
  const allowed = args.allowedMimes ?? DEFAULT_ATTACHMENT_MIMES;
  if (args.buffer.length === 0) {
    throw new AttachmentValidationError('empty', 'Attachment is empty.');
  }
  const limit = args.maxBytes ?? env.MAX_ATTACHMENT_BYTES;
  if (args.buffer.length > limit) {
    throw new AttachmentValidationError(
      'too_large',
      `Attachment exceeds ${Math.round(limit / 1024 / 1024)} MB limit.`,
    );
  }
  if (!allowed.includes(args.declaredMime)) {
    throw new AttachmentValidationError(
      'mime_not_allowed',
      `File type "${args.declaredMime}" is not accepted.`,
    );
  }

  const sha256 = createHash('sha256').update(args.buffer).digest('hex');
  if (!/^[a-z0-9]+$/i.test(args.orgId)) {
    throw new Error('Invalid orgId for storage path');
  }
  const dir = join(env.ATTACHMENTS_DIR, args.orgId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ext = args.filename.includes('.') ? args.filename.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
  const safeExt = ext && ext.length <= 12 ? ext : 'bin';
  const storagePath = join(dir, `${sha256}.${safeExt}`);
  const stagedPath = join(dir, `.${sha256}.${randomUUID()}.partial`);
  await writeFile(stagedPath, args.buffer, { mode: 0o600, flag: 'wx' });
  let staged = true;
  const discard = async () => {
    if (!staged) return;
    staged = false;
    await rm(stagedPath, { force: true });
  };
  return {
    relativePath: `${args.orgId}/${sha256}.${safeExt}`,
    sizeBytes: args.buffer.length,
    sha256,
    mimeType: args.declaredMime,
    filename: args.filename,
    async commit() {
      // Same name, same bytes: an existing file is already the right one.
      if (existsSync(storagePath)) return discard();
      await rename(stagedPath, storagePath);
      staged = false;
    },
    discard,
  };
}

export async function readAttachment(relativePath: string): Promise<Buffer> {
  const env = getEnv();
  const root = resolve(env.ATTACHMENTS_DIR);
  const full = resolve(root, relativePath);
  if (!full.startsWith(root + '/')) {
    throw new Error('Invalid attachment path');
  }
  return readFile(full);
}

function orgUploadDir(uploadsDir: string, orgId: string): string {
  // Defensive: orgId is a cuid, so should never contain path separators,
  // but explicitly reject anything other than [a-z0-9].
  if (!/^[a-z0-9]+$/i.test(orgId)) {
    throw new Error('Invalid orgId for storage path');
  }
  return join(uploadsDir, orgId);
}

export type UploadValidationCode =
  | 'not_pdf'
  | 'too_large'
  | 'password_protected'
  | 'unreadable_pdf'
  | 'pdf_too_complex'
  | 'unsupported_form'
  /** The PDF worker has no free slot (or is not installed). */
  | 'busy'
  /** The envelope already holds PDF_MAX_ENVELOPE_ITEMS documents. */
  | 'too_many_documents'
  /** This document would push the envelope past its envelope-wide seal caps. */
  | 'envelope_too_complex';

export class UploadValidationError extends Error {
  readonly code: UploadValidationCode;
  constructor(code: UploadValidationCode, message: string) {
    super(message);
    this.name = 'UploadValidationError';
    this.code = code;
  }
}

/** Virus-scan extension point. v1 returns CLEAN unconditionally; ClamAV swap documented in DEPLOYMENT.md. */
export async function scanFile(_buffer: Buffer): Promise<'CLEAN' | 'INFECTED' | 'ERROR'> {
  return 'CLEAN';
}
