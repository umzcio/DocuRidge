import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { getEnv } from './env';

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

/**
 * Save a PDF buffer to org-scoped storage. Returns the metadata needed for
 * a `DocumentFile` row. Idempotent — re-uploading the same content reuses
 * the existing file (content-addressed).
 */
export async function saveUploadedPdf(args: {
  orgId: string;
  buffer: Buffer;
  declaredMime: string;
}): Promise<StoredFile> {
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
  // Probe for true (user-password) encryption. We pass ignoreEncryption=true
  // throughout the seal pipeline so owner-password PDFs (no-print / no-copy
  // restrictions) flow through silently. But if the document is actually
  // encrypted with a user password, pdf-lib can't decrypt the content
  // streams even with ignoreEncryption — surface that here with a useful
  // error rather than letting it blow up mid-seal.
  try {
    const { PDFDocument } = await import('pdf-lib');
    await PDFDocument.load(args.buffer, { ignoreEncryption: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypt|password|decrypt/i.test(msg)) {
      throw new UploadValidationError(
        'password_protected',
        'This PDF is password-protected. Open it in a PDF reader, save a copy without the password, and re-upload.',
      );
    }
    throw new UploadValidationError(
      'unreadable_pdf',
      'PDF file looks corrupted or unreadable. Try re-saving from your PDF tool and uploading again.',
    );
  }

  const sha256 = createHash('sha256').update(args.buffer).digest('hex');
  const dir = orgUploadDir(env.UPLOADS_DIR, args.orgId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, `${sha256}.pdf`);
  if (!existsSync(storagePath)) {
    await writeFile(storagePath, args.buffer, { mode: 0o600 });
  }
  return {
    storagePath,
    relativePath: `${args.orgId}/${sha256}.pdf`,
    sizeBytes: args.buffer.length,
    sha256,
    mimeType: 'application/pdf',
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

export async function saveSealedPdf(args: {
  orgId: string;
  envelopeId: string;
  buffer: Buffer;
}): Promise<StoredFile> {
  const env = getEnv();
  const sha256 = createHash('sha256').update(args.buffer).digest('hex');
  const dir = join(env.SEALED_DIR, args.orgId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, `${args.envelopeId}.pdf`);
  await writeFile(storagePath, args.buffer, { mode: 0o600 });
  return {
    storagePath,
    relativePath: `${args.orgId}/${args.envelopeId}.pdf`,
    sizeBytes: args.buffer.length,
    sha256,
    mimeType: 'application/pdf',
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

/**
 * Save a recipient-uploaded supporting file. Path is content-addressed
 * (sha256-named) so re-uploading the same file is a no-op. Caller is
 * responsible for persisting the FieldAttachment row.
 */
export async function saveRecipientAttachment(args: {
  orgId: string;
  buffer: Buffer;
  filename: string;
  declaredMime: string;
  /** Optional override of the project default MIME allowlist. */
  allowedMimes?: readonly string[];
  /** Optional override of the per-attachment size cap. */
  maxBytes?: number;
}): Promise<StoredFile & { filename: string }> {
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
  if (!existsSync(storagePath)) {
    await writeFile(storagePath, args.buffer, { mode: 0o600 });
  }
  return {
    storagePath,
    relativePath: `${args.orgId}/${sha256}.${safeExt}`,
    sizeBytes: args.buffer.length,
    sha256,
    mimeType: args.declaredMime,
    filename: args.filename,
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

export class UploadValidationError extends Error {
  readonly code: 'not_pdf' | 'too_large' | 'password_protected' | 'unreadable_pdf';
  constructor(code: 'not_pdf' | 'too_large' | 'password_protected' | 'unreadable_pdf', message: string) {
    super(message);
    this.name = 'UploadValidationError';
    this.code = code;
  }
}

/** Virus-scan extension point. v1 returns CLEAN unconditionally; ClamAV swap documented in DEPLOYMENT.md. */
export async function scanFile(_buffer: Buffer): Promise<'CLEAN' | 'INFECTED' | 'ERROR'> {
  return 'CLEAN';
}
