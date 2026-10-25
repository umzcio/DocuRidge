/**
 * The canonical-documents backfill: `node canonical-backfill.cjs [--dry-run]
 * [--retry-refused] [--recanonicalize]`, run from the app directory so the
 * PDF worker bundle is found. It canonicalizes every source document that an
 * envelope item references, one at a time, and prints one JSON line per
 * document and a summary line. The report holds ids, titles and fixed words
 * only: never PDF content, an original's sha256, a storage path or an
 * exception's message.
 */

import { prisma } from '../prisma';
import {
  CURRENT_CANONICAL_VERSION,
  CanonicalRefusedError,
  canonicalizeStored,
  ensureCanonicalDocument,
} from '../pdf/canonical-source';
import { CanonicalUnavailableError, readPdfFromStorage } from '../storage';
import { PdfWorkerError } from '../pdf-worker/runner';
import { QpdfMissingError } from '../pdf/decrypt';

type Status = 'ok' | 'already' | 'refused' | 'busy' | 'error';
type ErrorCategory = 'worker_crashed' | 'qpdf_missing' | 'unavailable' | 'internal';

interface Options {
  dryRun: boolean;
  retryRefused: boolean;
  recanonicalize: boolean;
}

export interface BackfillIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE = 'Usage: canonical-backfill [--dry-run] [--retry-refused] [--recanonicalize]\n';

function parseArgs(argv: string[]): Options | null {
  const options: Options = { dryRun: false, retryRefused: false, recanonicalize: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--retry-refused') options.retryRefused = true;
    else if (arg === '--recanonicalize') options.recanonicalize = true;
    else return null;
  }
  return options;
}

/** The fixed word for a failure; the exception's own text never reaches the report. */
function errorCategory(err: unknown): ErrorCategory {
  if (err instanceof QpdfMissingError) return 'qpdf_missing';
  if (err instanceof PdfWorkerError) return 'worker_crashed';
  if (err instanceof CanonicalUnavailableError) return 'unavailable';
  return 'internal';
}

interface Outcome {
  status: Status;
  key?: string;
  error?: ErrorCategory;
  /** The canonical page count, when there is (or would be) a copy. */
  pageCount?: number;
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

/** Run the backfill. Returns the exit code: 0, 1 when any row ended busy or error, 2 for bad arguments. */
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

  const tally = { ok: 0, already: 0, refused: 0, busy: 0, error: 0 };
  let itemsFixed = 0;
  let fieldsOutOfRange = 0;

  for (const { id } of targets) {
    let outcome: Outcome;
    try {
      let row = await prisma.documentFile.findUnique({ where: { id }, select: ROW_SELECT });
      if (!row) throw new CanonicalUnavailableError();
      const redo =
        row.canonicalSha256 !== null &&
        row.canonicalVersion !== null &&
        row.canonicalVersion < CURRENT_CANONICAL_VERSION;
      const retry = row.canonicalRefusal !== null && options.retryRefused;
      const clear = (options.recanonicalize && redo) || retry;
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
            canonicalSealCost: null as never,
            canonicalRefusal: null,
          },
        });
        row = await prisma.documentFile.findUnique({ where: { id }, select: ROW_SELECT });
        if (!row) throw new CanonicalUnavailableError();
      }
      const view = clear && options.dryRun ? { ...row, canonicalSha256: null, canonicalPageCount: null, canonicalRefusal: null } : row;
      outcome = options.dryRun ? await dryOutcome(view) : await realOutcome(id, row.canonicalSha256 !== null);
    } catch (err) {
      if (err instanceof CanonicalRefusedError) outcome = { status: 'refused', key: err.key };
      else if (err instanceof PdfWorkerError && (err.reason === 'busy' || err.reason === 'unavailable')) {
        outcome = { status: 'busy' };
      } else outcome = { status: 'error', error: errorCategory(err) };
    }
    tally[outcome.status]++;

    const line: Record<string, unknown> = { documentFileId: id, status: outcome.status };
    if (outcome.key) line.key = outcome.key;
    if (outcome.error) line.error = outcome.error;
    try {
      const items = await prisma.envelopeItem.findMany({
        where: { documentFileId: id },
        select: { id: true, envelopeId: true, title: true, pageCount: true, envelope: { select: { status: true } } },
        orderBy: [{ envelopeId: 'asc' }, { order: 'asc' }],
      });
      line.items = items.map((i) => ({ envelopeId: i.envelopeId, status: i.envelope.status, title: i.title }));
      const count = outcome.pageCount;
      if (count !== undefined && (outcome.status === 'ok' || outcome.status === 'already')) {
        const fixed: Array<{ envelopeId: string; itemId: string; from: number; to: number }> = [];
        const beyond: Array<{ envelopeId: string; itemId: string; fieldId: string; page: number }> = [];
        for (const item of items) {
          if (item.pageCount !== count) {
            if (!options.dryRun) await prisma.envelopeItem.update({ where: { id: item.id }, data: { pageCount: count } });
            fixed.push({ envelopeId: item.envelopeId, itemId: item.id, from: item.pageCount, to: count });
          }
          const fields = await prisma.field.findMany({
            where: { envelopeItemId: item.id, page: { gt: count } },
            select: { id: true, page: true },
            orderBy: { id: 'asc' },
          });
          for (const f of fields) beyond.push({ envelopeId: item.envelopeId, itemId: item.id, fieldId: f.id, page: f.page });
        }
        if (fixed.length > 0) line.pageCountFixed = fixed;
        if (beyond.length > 0) line.fieldsOutOfRange = beyond;
        itemsFixed += fixed.length;
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
      fieldsOutOfRange,
    }),
  );
  return tally.busy > 0 || tally.error > 0 ? 1 : 0;
}
