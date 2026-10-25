/**
 * The canonical copy of a stored document, made on demand when its row has
 * none (rows from before canonical copies existed, or whose upload predates
 * this code). Parent-side: it reads the database and storage and runs the
 * canonicalize job in the PDF worker; it never parses a PDF itself.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  CanonicalUnavailableError,
  readPdfFromStorage,
  runCanonicalizeJob,
  writeCanonicalPdf,
} from '../storage';
import { PdfWorkerError } from '../pdf-worker/runner';
import { CANONICAL_REFUSAL_MESSAGES, type CanonicalRefusalKey, type CanonicalizeResult } from './canonical-result';
import type { PdfSealCost } from './seal-limits';

/**
 * The canonicalizer's output version, stored with every canonical copy and
 * refusal. Bump it only when the canonical output changes on purpose. A row
 * with a lower version keeps its copy here (a signer may already have seen
 * those bytes); only the backfill's `--recanonicalize` redoes it.
 */
export const CURRENT_CANONICAL_VERSION = 1;

export interface CanonicalDocument {
  documentFileId: string;
  /** `<orgId>/canonical/<sha256>.pdf`, under UPLOADS_DIR. */
  storagePath: string;
  sha256: string;
  pageCount: number;
  sealCost: PdfSealCost;
}

/** The canonicalizer refused this document; the refusal is stored and never retried on demand. */
export class CanonicalRefusedError extends Error {
  constructor(readonly key: CanonicalRefusalKey) {
    super(CANONICAL_REFUSAL_MESSAGES[key]);
    this.name = 'CanonicalRefusedError';
  }
}

const ROW_SELECT = {
  id: true,
  orgId: true,
  storagePath: true,
  canonicalStoragePath: true,
  canonicalSha256: true,
  canonicalPageCount: true,
  canonicalSealCost: true,
  canonicalRefusal: true,
} satisfies Prisma.DocumentFileSelect;

type Row = Prisma.DocumentFileGetPayload<{ select: typeof ROW_SELECT }>;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function storedSealCost(value: Prisma.JsonValue | null): PdfSealCost | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { pages, objects, bytes } = value as Record<string, unknown>;
  return isCount(pages) && isCount(objects) && isCount(bytes) ? { pages, objects, bytes } : null;
}

function isRefusalKey(value: string): value is CanonicalRefusalKey {
  return Object.prototype.hasOwnProperty.call(CANONICAL_REFUSAL_MESSAGES, value);
}

/**
 * What a row already says: its canonical copy, a thrown stored refusal, or
 * null when it has neither yet. A copy whose columns are incomplete or
 * malformed is unavailable rather than redone: its sha256 is set, so the
 * conditional write below could never replace it.
 */
function settled(row: Row): CanonicalDocument | null {
  if (row.canonicalRefusal !== null) {
    throw new CanonicalRefusedError(isRefusalKey(row.canonicalRefusal) ? row.canonicalRefusal : 'unreadable_pdf');
  }
  if (row.canonicalSha256 === null) return null;
  const sealCost = storedSealCost(row.canonicalSealCost);
  if (row.canonicalStoragePath === null || !isCount(row.canonicalPageCount) || row.canonicalPageCount < 1 || !sealCost) {
    throw new CanonicalUnavailableError();
  }
  return {
    documentFileId: row.id,
    storagePath: row.canonicalStoragePath,
    sha256: row.canonicalSha256,
    pageCount: row.canonicalPageCount,
    sealCost,
  };
}

async function loadRow(documentFileId: string): Promise<Row> {
  const row = await prisma.documentFile.findUnique({ where: { id: documentFileId }, select: ROW_SELECT });
  if (!row) throw new CanonicalUnavailableError();
  return row;
}

type Canonicalized = Extract<CanonicalizeResult, { ok: true }> | { ok: false; key: CanonicalRefusalKey };

/**
 * Canonicalize stored original bytes. Legacy rows may predate decryption at
 * upload, so this does what upload does: on `encrypted`, decrypt with qpdf
 * here in the parent and canonicalize the decrypted bytes. A file qpdf cannot
 * decrypt, or one still encrypted afterwards, is unreadable.
 *
 * Worker failures propagate as PdfWorkerError and are never stored: `busy`,
 * `unavailable` and `crashed` may pass, and so may `timeout` and
 * `out_of_memory`, which a loaded host can cause on a file that is fine (an
 * upload's timeout is refused instead, in storage.ts, since nothing depends
 * on it yet). A failed job (a child `fail`, whose text is the child's)
 * propagates as `crashed`. A missing qpdf propagates as QpdfMissingError,
 * unstored. Exported for the backfill's dry run, which must report what a
 * real run would do without writing.
 */
export async function canonicalizeStored(bytes: Uint8Array): Promise<Canonicalized> {
  const run = async (input: Uint8Array, ignoreEncryption: boolean): Promise<CanonicalizeResult> => {
    try {
      return await runCanonicalizeJob(input, ignoreEncryption ? { ignoreEncryption: true } : {});
    } catch (err) {
      // A child `fail` carries the child's text, which no caller may surface.
      throw err instanceof PdfWorkerError ? err : new PdfWorkerError('crashed');
    }
  };
  let result = await run(bytes, true);
  if (!result.ok && result.key === 'encrypted') {
    const { decryptPdf, QpdfMissingError } = await import('./decrypt');
    let decrypted: Buffer;
    try {
      decrypted = await decryptPdf(Buffer.from(bytes));
    } catch (err) {
      // No qpdf is a deployment fault, not a property of the file: not stored.
      if (err instanceof QpdfMissingError) throw err;
      return { ok: false, key: 'unreadable_pdf' };
    }
    result = await run(decrypted, false);
  }
  if (result.ok) return result;
  return { ok: false, key: result.key === 'encrypted' ? 'unreadable_pdf' : result.key };
}

/**
 * The canonical copy of one stored document, made now if the row has none.
 *
 * A row with a copy is returned without a job, and a row with a stored
 * refusal throws CanonicalRefusedError without one. Otherwise the original is
 * read and canonicalized; the copy is written to storage and its columns are
 * set only where the row still has none, then the row is read again, so a
 * concurrent caller that won returns, and gets, the winner's values. A
 * refusal is stored the same way and thrown.
 *
 * Throws CanonicalUnavailableError when the row or its original cannot be
 * read, or the copy cannot be written or the row read back (not stored: the
 * file may come back; the database or file-system error's own text never
 * leaves here), PdfWorkerError when the worker is busy, unavailable, crashed,
 * timed out or ran out of memory, and QpdfMissingError when decryption needs
 * a qpdf the deployment lacks (none of these is stored).
 */
export async function ensureCanonicalDocument(documentFileId: string): Promise<CanonicalDocument> {
  const row = await loadRow(documentFileId);
  const existing = settled(row);
  if (existing) return existing;

  let original: Buffer;
  try {
    original = await readPdfFromStorage(row.storagePath);
  } catch {
    throw new CanonicalUnavailableError();
  }

  const result = await canonicalizeStored(original);
  const unset = { id: row.id, canonicalSha256: null, canonicalRefusal: null };
  if (result.ok) {
    let written: Awaited<ReturnType<typeof writeCanonicalPdf>>;
    try {
      written = await writeCanonicalPdf({ orgId: row.orgId, bytes: result.bytes });
    } catch {
      // A full disk or a permissions fault: nothing is stored, and its text
      // (which names paths) goes no further.
      throw new CanonicalUnavailableError();
    }
    await prisma.documentFile.updateMany({
      where: unset,
      data: {
        canonicalStoragePath: written.relativePath,
        canonicalSha256: written.sha256,
        canonicalVersion: CURRENT_CANONICAL_VERSION,
        canonicalPageCount: result.pageCount,
        canonicalSealCost: { ...result.sealCost },
      },
    });
  } else {
    await prisma.documentFile.updateMany({
      where: unset,
      data: { canonicalRefusal: result.key, canonicalVersion: CURRENT_CANONICAL_VERSION },
    });
  }

  let reread: Row;
  try {
    reread = await loadRow(documentFileId);
  } catch (err) {
    if (err instanceof CanonicalUnavailableError) throw err;
    throw new CanonicalUnavailableError();
  }
  const stored = settled(reread);
  // Both writes are conditional on an unset row, and nothing clears one.
  if (!stored) throw new CanonicalUnavailableError();
  return stored;
}

/** `ensureCanonicalDocument` for each envelope item, one at a time, in item order. */
export async function ensureEnvelopeCanonical(
  items: ReadonlyArray<{ title: string; documentFileId: string }>,
): Promise<CanonicalDocument[]> {
  const docs: CanonicalDocument[] = [];
  for (const item of items) docs.push(await ensureCanonicalDocument(item.documentFileId));
  return docs;
}
