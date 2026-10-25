/**
 * The canonical-documents backfill: `node canonical-backfill.cjs [--dry-run]
 * [--retry-refused] [--recanonicalize]`, or `[--dry-run] --verify [--repair]`,
 * run from the app directory so the PDF worker bundle is found. It
 * canonicalizes every source document that an envelope item references, one
 * at a time (or, with `--verify`, checks every stored canonical copy), and
 * prints one JSON line per document and a summary line. The report holds ids,
 * titles and fixed words only: never PDF content, an original's sha256, a
 * storage path or an exception's message.
 */

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  CURRENT_CANONICAL_VERSION,
  CanonicalRefusedError,
  canonicalizeStored,
  ensureCanonicalDocument,
} from '../pdf/canonical-source';
import {
  CanonicalIntegrityError,
  CanonicalUnavailableError,
  readCanonicalPdf,
  readPdfFromStorage,
  writeCanonicalPdf,
} from '../storage';
import { PdfWorkerError } from '../pdf-worker/runner';
import { QpdfMissingError } from '../pdf/decrypt';

type Status = 'ok' | 'already' | 'refused' | 'busy' | 'error' | 'skipped_in_use';
type VerifyStatus =
  | 'verified' | 'missing' | 'mismatch' | 'repaired' | 'would_repair' | 'repair_mismatch' | 'busy' | 'error';
type ErrorCategory =
  | 'worker_crashed'
  | 'worker_timeout'
  | 'worker_out_of_memory'
  | 'qpdf_missing'
  | 'unavailable'
  | 'unexpected_path'
  | 'internal';

interface Options {
  dryRun: boolean;
  retryRefused: boolean;
  recanonicalize: boolean;
  verify: boolean;
  repair: boolean;
}

export interface BackfillIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE =
  'Usage: canonical-backfill [--dry-run] [--retry-refused] [--recanonicalize]\n' +
  '       canonical-backfill [--dry-run] --verify [--repair]\n';

function parseArgs(argv: string[]): Options | null {
  const options: Options = { dryRun: false, retryRefused: false, recanonicalize: false, verify: false, repair: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--retry-refused') options.retryRefused = true;
    else if (arg === '--recanonicalize') options.recanonicalize = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--repair') options.repair = true;
    else return null;
  }
  // --repair only mends what --verify finds; --verify never clears a row.
  if (options.repair && !options.verify) return null;
  if (options.verify && (options.retryRefused || options.recanonicalize)) return null;
  return options;
}

/** The fixed word for a failure; the exception's own text never reaches the report. */
function errorCategory(err: unknown): ErrorCategory {
  if (err instanceof QpdfMissingError) return 'qpdf_missing';
  if (err instanceof PdfWorkerError) {
    if (err.reason === 'timeout') return 'worker_timeout';
    if (err.reason === 'out_of_memory') return 'worker_out_of_memory';
    return 'worker_crashed';
  }
  if (err instanceof CanonicalUnavailableError) return 'unavailable';
  return 'internal';
}

const isBusy = (err: unknown) => err instanceof PdfWorkerError && (err.reason === 'busy' || err.reason === 'unavailable');

interface ItemRow {
  id: string;
  envelopeId: string;
  title: string;
  pageCount: number;
  envelope: { status: string; type: string };
}

async function loadItems(documentFileId: string): Promise<ItemRow[]> {
  return prisma.envelopeItem.findMany({
    where: { documentFileId },
    select: {
      id: true, envelopeId: true, title: true, pageCount: true, envelope: { select: { status: true, type: true } },
    },
    orderBy: [{ envelopeId: 'asc' }, { order: 'asc' }],
  });
}

/** Envelopes still open for signing, whose items' page counts the backfill may correct. */
const OPEN_STATUSES = new Set(['DRAFT', 'SENT', 'IN_PROGRESS']);

/**
 * Whether an item's envelope forbids clearing the row it uses. A template's
 * row is shared by every envelope made from it. A row a sent document uses
 * may already have been shown to a signer as it is, so a new copy would
 * break "what was shown is what is sealed". A refused row was never shown,
 * so `--retry-refused` may still clear it under a sent or in-progress
 * envelope; a finished envelope keeps whatever it ended with.
 */
function blocksClearing(envelope: ItemRow['envelope'], mode: 'retry' | 'redo'): boolean {
  if (envelope.type !== 'DOCUMENT') return true;
  return mode === 'redo' ? envelope.status !== 'DRAFT' : !OPEN_STATUSES.has(envelope.status);
}

interface Outcome {
  status: Status;
  key?: string;
  error?: ErrorCategory;
  /** The canonical page count, when there is (or would be) a copy. */
  pageCount?: number;
  /** The envelopes that kept a row from being cleared. */
  inUse?: Array<{ envelopeId: string; type: string; status: string }>;
}

const ROW_SELECT = {
  id: true,
  storagePath: true,
  canonicalSha256: true,
  canonicalVersion: true,
  canonicalPageCount: true,
  canonicalRefusal: true,
} as const;

/** What a real run would do with the row, computed without writing anything. */
async function dryOutcome(row: {
  storagePath: string;
  canonicalSha256: string | null;
  canonicalPageCount: number | null;
  canonicalRefusal: string | null;
}): Promise<Outcome> {
  if (row.canonicalRefusal !== null) return { status: 'refused', key: row.canonicalRefusal };
  if (row.canonicalSha256 !== null && row.canonicalPageCount !== null) {
    return { status: 'already', pageCount: row.canonicalPageCount };
  }
  const result = await canonicalizeStored(await readPdfFromStorage(row.storagePath));
  return result.ok ? { status: 'ok', pageCount: result.pageCount } : { status: 'refused', key: result.key };
}

async function realOutcome(id: string, hadCopy: boolean): Promise<Outcome> {
  const doc = await ensureCanonicalDocument(id);
  return { status: hadCopy ? 'already' : 'ok', pageCount: doc.pageCount };
}

/** The row's outcome, clearing it first when a flag asks and no envelope forbids it. */
async function backfillRow(id: string, items: ItemRow[], options: Options): Promise<Outcome> {
  let row = await prisma.documentFile.findUnique({ where: { id }, select: ROW_SELECT });
  if (!row) throw new CanonicalUnavailableError();
  const redo =
    row.canonicalSha256 !== null &&
    row.canonicalVersion !== null &&
    row.canonicalVersion < CURRENT_CANONICAL_VERSION;
  const retry = row.canonicalRefusal !== null && options.retryRefused;
  const clear = (options.recanonicalize && redo) || retry;
  if (clear) {
    const mode = retry ? 'retry' : 'redo';
    const inUse = items.filter((item) => blocksClearing(item.envelope, mode));
    if (inUse.length > 0) {
      return {
        status: 'skipped_in_use',
        inUse: inUse.map((item) => ({ envelopeId: item.envelopeId, type: item.envelope.type, status: item.envelope.status })),
      };
    }
  }
  if (clear && !options.dryRun) {
    // The same conditional write the canonicalizer uses: only a row that
    // still holds what was read is cleared.
    await prisma.documentFile.updateMany({
      where: { id, canonicalSha256: row.canonicalSha256, canonicalRefusal: row.canonicalRefusal },
      data: {
        canonicalStoragePath: null,
        canonicalSha256: null,
        canonicalVersion: null,
        canonicalPageCount: null,
        canonicalSealCost: Prisma.DbNull,
        canonicalRefusal: null,
      },
    });
    row = await prisma.documentFile.findUnique({ where: { id }, select: ROW_SELECT });
    if (!row) throw new CanonicalUnavailableError();
  }
  const view = clear && options.dryRun ? { ...row, canonicalSha256: null, canonicalPageCount: null, canonicalRefusal: null } : row;
  return options.dryRun ? dryOutcome(view) : realOutcome(id, row.canonicalSha256 !== null);
}

async function runBackfill(targets: Array<{ id: string }>, options: Options, stdout: (line: string) => void): Promise<number> {
  const tally = { ok: 0, already: 0, refused: 0, busy: 0, error: 0, skipped_in_use: 0 };
  let itemsFixed = 0;
  let itemsDiffering = 0;
  let fieldsOutOfRange = 0;

  for (const { id } of targets) {
    let outcome: Outcome;
    let items: ItemRow[] | null = null;
    try {
      items = await loadItems(id);
      outcome = await backfillRow(id, items, options);
    } catch (err) {
      if (err instanceof CanonicalRefusedError) outcome = { status: 'refused', key: err.key };
      else if (isBusy(err)) outcome = { status: 'busy' };
      else outcome = { status: 'error', error: errorCategory(err) };
    }
    tally[outcome.status]++;

    const line: Record<string, unknown> = { documentFileId: id, status: outcome.status };
    if (outcome.key) line.key = outcome.key;
    if (outcome.error) line.error = outcome.error;
    if (outcome.inUse) line.inUse = outcome.inUse;
    if (items) line.items = items.map((i) => ({ envelopeId: i.envelopeId, status: i.envelope.status, title: i.title }));
    try {
      const count = outcome.pageCount;
      if (items && count !== undefined && (outcome.status === 'ok' || outcome.status === 'already')) {
        const fixed: Array<{ envelopeId: string; itemId: string; from: number; to: number }> = [];
        const differs: Array<{ envelopeId: string; itemId: string; status: string; from: number; to: number }> = [];
        const beyond: Array<{ envelopeId: string; itemId: string; fieldId: string; page: number }> = [];
        for (const item of items) {
          if (item.pageCount !== count) {
            // Only an envelope still open for signing (or a template) is
            // corrected; a finished one keeps its record and is reported.
            if (item.envelope.type === 'TEMPLATE' || OPEN_STATUSES.has(item.envelope.status)) {
              if (!options.dryRun) await prisma.envelopeItem.update({ where: { id: item.id }, data: { pageCount: count } });
              fixed.push({ envelopeId: item.envelopeId, itemId: item.id, from: item.pageCount, to: count });
            } else {
              differs.push({ envelopeId: item.envelopeId, itemId: item.id, status: item.envelope.status, from: item.pageCount, to: count });
            }
          }
          const fields = await prisma.field.findMany({
            where: { envelopeItemId: item.id, page: { gt: count } },
            select: { id: true, page: true },
            orderBy: { id: 'asc' },
          });
          for (const f of fields) beyond.push({ envelopeId: item.envelopeId, itemId: item.id, fieldId: f.id, page: f.page });
        }
        if (fixed.length > 0) line.pageCountFixed = fixed;
        if (differs.length > 0) line.pageCountDiffers = differs;
        if (beyond.length > 0) line.fieldsOutOfRange = beyond;
        itemsFixed += fixed.length;
        itemsDiffering += differs.length;
        fieldsOutOfRange += beyond.length;
      }
    } catch {
      // The row's own result stands; the item pass is reported as failed.
      if (outcome.status !== 'error') {
        tally[outcome.status]--;
        tally.error++;
        line.status = 'error';
        line.error = 'internal';
      }
    }
    stdout(JSON.stringify(line));
  }

  stdout(
    JSON.stringify({
      summary: true,
      dryRun: options.dryRun,
      total: targets.length,
      ...tally,
      pageCountFixed: itemsFixed,
      pageCountDiffers: itemsDiffering,
      fieldsOutOfRange,
    }),
  );
  return tally.busy > 0 || tally.error > 0 ? 1 : 0;
}

interface VerifyRow {
  id: string;
  orgId: string;
  storagePath: string;
  canonicalStoragePath: string | null;
  canonicalSha256: string | null;
}

/**
 * Make the canonical file again from the original, and write it only if it
 * is byte for byte the copy the row names (canonicalization is
 * deterministic). The row is never changed.
 */
async function repairCopy(
  row: VerifyRow & { canonicalStoragePath: string; canonicalSha256: string },
  dryRun: boolean,
): Promise<{ status: VerifyStatus; error?: ErrorCategory }> {
  if (row.canonicalStoragePath !== `${row.orgId}/canonical/${row.canonicalSha256}.pdf`) {
    return { status: 'error', error: 'unexpected_path' };
  }
  const result = await canonicalizeStored(await readPdfFromStorage(row.storagePath));
  if (!result.ok) return { status: 'repair_mismatch' };
  const sha256 = createHash('sha256').update(result.bytes).digest('hex');
  if (sha256 !== row.canonicalSha256) return { status: 'repair_mismatch' };
  if (dryRun) return { status: 'would_repair' };
  await writeCanonicalPdf({ orgId: row.orgId, bytes: result.bytes, replace: true });
  await readCanonicalPdf({ storagePath: row.canonicalStoragePath, sha256: row.canonicalSha256 });
  return { status: 'repaired' };
}

async function runVerify(targets: Array<{ id: string }>, options: Options, stdout: (line: string) => void): Promise<number> {
  const tally: Record<VerifyStatus | 'unsettled', number> = {
    verified: 0, missing: 0, mismatch: 0, repaired: 0, would_repair: 0, repair_mismatch: 0, busy: 0, error: 0, unsettled: 0,
  };
  for (const { id } of targets) {
    const line: Record<string, unknown> = { documentFileId: id };
    let status: VerifyStatus;
    try {
      const row: VerifyRow | null = await prisma.documentFile.findUnique({
        where: { id },
        select: { id: true, orgId: true, storagePath: true, canonicalStoragePath: true, canonicalSha256: true },
      });
      if (!row || row.canonicalSha256 === null || row.canonicalStoragePath === null) {
        // No copy to check (none yet, or refused): the plain backfill's business.
        tally.unsettled++;
        continue;
      }
      let found: 'missing' | 'mismatch' | null = null;
      try {
        await readCanonicalPdf({ storagePath: row.canonicalStoragePath, sha256: row.canonicalSha256 });
      } catch (err) {
        if (err instanceof CanonicalIntegrityError) found = 'mismatch';
        else if (err instanceof CanonicalUnavailableError) found = 'missing';
        else throw err;
      }
      if (!found) {
        status = 'verified';
      } else if (!options.repair) {
        status = found;
      } else {
        line.found = found;
        const repaired = await repairCopy(
          { ...row, canonicalStoragePath: row.canonicalStoragePath, canonicalSha256: row.canonicalSha256 },
          options.dryRun,
        );
        status = repaired.status;
        if (repaired.error) line.error = repaired.error;
      }
    } catch (err) {
      if (isBusy(err)) status = 'busy';
      else {
        status = 'error';
        line.error = errorCategory(err);
      }
    }
    tally[status]++;
    line.status = status;
    try {
      const items = await loadItems(id);
      line.items = items.map((i) => ({ envelopeId: i.envelopeId, status: i.envelope.status, title: i.title }));
    } catch {
      // The listing is context only; the verdict above stands.
    }
    stdout(JSON.stringify(line));
  }
  stdout(JSON.stringify({ summary: true, verify: true, repair: options.repair, dryRun: options.dryRun, total: targets.length, ...tally }));
  const unresolved = tally.missing + tally.mismatch + tally.repair_mismatch + tally.would_repair + tally.busy + tally.error;
  return unresolved > 0 ? 1 : 0;
}

/** Run the backfill. Returns the exit code: 0, 1 when any row ended busy or error (or, verifying, unresolved), 2 for bad arguments. */
export async function main(argv: string[], io: BackfillIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = io.stderr ?? ((line: string) => process.stderr.write(line));
  const options = parseArgs(argv);
  if (!options) {
    stderr(USAGE);
    return 2;
  }

  // Sealed outputs have no envelope item and are not source documents.
  const targets = await prisma.documentFile.findMany({
    where: { envelopeItems: { some: {} } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  return options.verify ? runVerify(targets, options, stdout) : runBackfill(targets, options, stdout);
}
