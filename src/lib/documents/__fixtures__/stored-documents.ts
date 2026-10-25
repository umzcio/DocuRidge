import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Row = Record<string, unknown> & { id: string };
export const ORG = 'orgr';
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * A stateful stand-in for the document_file table, in the shape of
 * canonical-source.test.ts: findUnique returns a copy, updateMany writes only
 * when every `where` column still holds the given value.
 */
export function fakeDocumentFileTable(rows: Map<string, Row>) {
  return {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return row ? structuredClone(row) : null;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows.get(where.id as string);
      if (!row || !Object.entries(where).every(([k, v]) => row[k] === v)) return { count: 0 };
      Object.assign(row, structuredClone(data));
      return { count: 1 };
    },
  };
}

/** Store `original` as an upload under `uploadsDir` and add a legacy row (no canonical copy yet) for it. */
export function seedLegacyDocument(
  rows: Map<string, Row>,
  uploadsDir: string,
  id: string,
  original: Uint8Array,
): Row {
  const hash = sha256(original);
  mkdirSync(join(uploadsDir, ORG), { recursive: true });
  writeFileSync(join(uploadsDir, ORG, `${hash}.pdf`), original);
  const row: Row = {
    id,
    orgId: ORG,
    storagePath: `${ORG}/${hash}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: original.byteLength,
    sha256: hash,
    canonicalStoragePath: null,
    canonicalSha256: null,
    canonicalVersion: null,
    canonicalPageCount: null,
    canonicalSealCost: null,
    canonicalRefusal: null,
  };
  rows.set(id, row);
  return row;
}

/**
 * Give `row` its canonical copy, as upload does: canonicalize `original`
 * (inline, with the real canonicalizer), store the copy with
 * `writeCanonicalPdf` under the test's UPLOADS_DIR, and set the row's
 * canonical columns. Returns the canonical bytes; throws on a refusal.
 *
 * The modules are imported here, not at the top, so a test's `vi.mock` of
 * the env and the database is in place when they load.
 */
export async function storeCanonicalCopy(row: Row, original: Uint8Array): Promise<Uint8Array> {
  const { canonicalizeUploadedPdf } = await import('../../pdf/canonicalize');
  const { writeCanonicalPdf } = await import('../../storage');
  const { CURRENT_CANONICAL_VERSION } = await import('../../pdf/canonical-source');
  const result = await canonicalizeUploadedPdf(original);
  if (!result.ok) throw new Error(`the fixture was refused: ${result.key}`);
  const written = await writeCanonicalPdf({ orgId: row.orgId as string, bytes: result.bytes });
  Object.assign(row, {
    canonicalStoragePath: written.relativePath,
    canonicalSha256: written.sha256,
    canonicalVersion: CURRENT_CANONICAL_VERSION,
    canonicalPageCount: result.pageCount,
    canonicalSealCost: { ...result.sealCost },
  });
  return result.bytes;
}

/** `seedLegacyDocument` plus its canonical copy (`storeCanonicalCopy`): a row as upload leaves it. */
export async function seedCanonicalDocument(
  rows: Map<string, Row>,
  uploadsDir: string,
  id: string,
  original: Uint8Array,
): Promise<{ row: Row; canonical: Uint8Array }> {
  const row = seedLegacyDocument(rows, uploadsDir, id, original);
  return { row, canonical: await storeCanonicalCopy(row, original) };
}
