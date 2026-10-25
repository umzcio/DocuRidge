import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';
import { seedCanonicalDocument, seedLegacyDocument, sha256, type Row } from '../documents/__fixtures__/stored-documents';

/**
 * The seal is built from each document's canonical copy: its pages are
 * copied unchanged and the fields stamped on top, so the sealed pages show
 * what the signer was shown. The real seal, canonical-source, storage and
 * canonicalizer run (PDF jobs inline); the envelope and document_file rows,
 * the uploads dir and the org key are stand-ins.
 */

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-seal-canonical-'));
const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown> & { id: string }>(),
  envelope: null as unknown as Record<string, unknown>,
  key: null as unknown as {
    keyId: string; fingerprint: string; algorithm: 'ed25519';
    privateKey: Uint8Array; publicKey: Uint8Array; publicKeyPem: string;
  },
}));
vi.mock('../prisma', async () => {
  const { fakeDocumentFileTable } = await import('../documents/__fixtures__/stored-documents');
  return {
    prisma: {
      envelope: { findUnique: async () => state.envelope },
      documentFile: fakeDocumentFileTable(state.rows),
    },
  };
});
vi.mock('../env', () => ({ getEnv: () => ({ UPLOADS_DIR: uploadsDir }) }));
vi.mock('../crypto/org-key', async () => {
  const { vi: v } = await import('vitest');
  const { hexToBytes } = await import('../audit/canonical');
  const sign = async (hex: string) => Buffer.from(await ed.signAsync(hexToBytes(hex), state.key.privateKey)).toString('hex');
  return {
    getOrCreateOrgKey: async () => state.key,
    getOrgKeyForVerify: async () => null,
    signHex: v.fn(async (_orgId: string, hex: string) => sign(hex)),
    signHexWithKey: async (_key: unknown, hex: string) => sign(hex),
  };
});
vi.mock('../pdf-worker/runner', async (orig) => {
  const actual = await orig<typeof import('../pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});
vi.mock('./decrypt', async (orig) => ({
  ...(await orig<typeof import('./decrypt')>()),
  decryptPdf: vi.fn(),
}));

const { buildSealedEnvelope } = await import('./seal');
const { SealedContentStructureError } = await import('./page-tree');
const { CanonicalSealSourceError } = await import('./seal-errors');
const { runPdfJob, PdfWorkerError } = await import('../pdf-worker/runner');
const { signHex } = await import('../crypto/org-key');
const { decryptPdf, QpdfMissingError } = await import('./decrypt');
const { verifySealedPdf } = await import('../verify/sealed-pdf');
const { makeTestKey, solidPng } = await import('../verify/__fixtures__/sealed-pdf');
const { appendIncrementalUpdate } = await import('../verify/__fixtures__/pdf-surgery');
const { geometryPdf } = await import('./__fixtures__/geometry-pdf');
const { encryptedPdf } = await import('./__fixtures__/encrypted-pdf');
const { opaqueSquareOverText } = await import('./__fixtures__/policy-pdfs');

const realRun = vi.mocked(runPdfJob).getMockImplementation()!;
const SIGNATURE_PNG = solidPng(10, 20, 30, 8).toString('base64');

beforeAll(async () => {
  const test = await makeTestKey();
  state.key = {
    keyId: 'key1', fingerprint: test.fingerprint, algorithm: 'ed25519', privateKey: test.privateKey,
    publicKey: await ed.getPublicKeyAsync(test.privateKey), publicKeyPem: test.publicKeyPem,
  };
});
beforeEach(() => {
  state.rows.clear();
  vi.mocked(runPdfJob).mockReset().mockImplementation(realRun);
  vi.mocked(signHex).mockClear();
  vi.mocked(decryptPdf).mockReset();
});
afterAll(() => rmSync(uploadsDir, { recursive: true, force: true }));

async function textPdf(pages: number, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${text} ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return doc.save();
}

interface FieldSpec { id: string; type: string; page: number; x: number; y: number; w: number; h: number; value?: string }

/** A COMPLETED one-recipient envelope over the given document_file rows, with `fields` on the first item. */
function envelopeOver(documentFileIds: string[], fields: FieldSpec[] = []) {
  return {
    id: 'env1', orgId: 'org1', title: 'Contract', status: 'COMPLETED',
    sentAt: new Date('2026-10-24T15:10:00.000Z'), completedAt: new Date('2026-10-24T15:30:00.000Z'),
    org: { name: 'Org' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: documentFileIds.map((documentFileId, i) => ({
      id: `item${i}`, order: i + 1, title: `doc-${i}.pdf`, pageCount: 1, documentFileId,
      documentFile: structuredClone(state.rows.get(documentFileId)),
    })),
    recipients: [{
      id: 'r1', name: 'Alice', email: 'alice@example.com', recipientRole: 'SIGNER', signingOrder: 1,
      signingStatus: 'SIGNED', signedAt: new Date('2026-10-24T15:20:00.000Z'),
      signatures: [{ imagePngBase64: SIGNATURE_PNG, typedSignature: 'Alice Signer', fieldId: 'sig' }],
    }],
    fields: fields.map((f) => ({
      envelopeItemId: 'item0', recipientId: 'r1', value: null, meta: null, attachment: null,
      recipient: { name: 'Alice', email: 'alice@example.com' }, ...f,
    })),
    auditEvents: [],
  };
}

const trust = () => ({ trust: { publicKeys: [], fingerprints: [state.key.fingerprint], source: 'test' } });
const decoded = (stream: PDFRawStream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');

function rawStream(page: PDFPage, object: unknown): PDFRawStream {
  if (!(object instanceof PDFRawStream)) throw new Error(`expected a stream on page ${page.ref.toString()}`);
  return object;
}

/** A page's content streams, in order. */
function contentStreams(page: PDFPage): PDFRawStream[] {
  const contents = page.node.get(PDFName.of('Contents'));
  const resolved = page.doc.context.lookup(contents);
  const items = resolved instanceof PDFArray ? resolved.asArray() : [contents];
  return items.map((item) => rawStream(page, page.doc.context.lookup(item)));
}

/** The Form XObject a content stream draws with its one `Do`, looked up in `page`'s resources. */
function drawnXObject(page: PDFPage, content: string): PDFRawStream {
  const names = [...content.matchAll(/\/(\S+) Do\b/g)].map((m) => m[1]!);
  expect(names).toHaveLength(1);
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  return rawStream(page, page.doc.context.lookup(xobjects.get(PDFName.of(names[0]!))));
}

const numbers = (dict: PDFDict, key: string) => dict.lookup(PDFName.of(key), PDFArray).asArray().map(String);

describe('sealing from the canonical copy', () => {
  it("the sealed page draws the canonical page's content unchanged", async () => {
    const { canonical } = await seedCanonicalDocument(state.rows, uploadsDir, 'df1', await textPdf(2, 'TERMS'));
    state.envelope = envelopeOver(['df1'], [
      { id: 'sig', type: 'SIGNATURE', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
      { id: 'txt', type: 'TEXT', page: 2, x: 0.1, y: 0.5, w: 0.3, h: 0.05, value: 'Typed answer' },
    ]);

    const build = await buildSealedEnvelope({ envelopeId: 'env1' });

    const source = await PDFDocument.load(canonical);
    const sealed = await PDFDocument.load(build.bytes);
    expect(sealed.getPageCount()).toBe(3); // + audit page
    for (const [i, canonicalPage] of source.getPages().entries()) {
      const sealedPage = sealed.getPage(i);
      const [canonicalContent, ...rest] = contentStreams(canonicalPage);
      expect(rest).toEqual([]);
      // pdf-lib brackets a copied page's own content in q ... Q before drawing on it.
      const [open, content, close, ...stamps] = contentStreams(sealedPage);
      expect(decoded(open!).trim()).toBe('q');
      expect(Buffer.from(content!.getContents()).equals(Buffer.from(canonicalContent!.getContents()))).toBe(true);
      expect(decoded(close!).trim()).toBe('Q');

      const want = drawnXObject(canonicalPage, decoded(canonicalContent!));
      const got = drawnXObject(sealedPage, decoded(content!));
      expect(Buffer.from(got.getContents()).equals(Buffer.from(want.getContents()))).toBe(true);
      expect(numbers(got.dict, 'BBox')).toEqual(numbers(want.dict, 'BBox'));
      expect(numbers(got.dict, 'Matrix')).toEqual(numbers(want.dict, 'Matrix'));

      // The stamps come after the page's content, never inside it.
      expect(stamps.length).toBeGreaterThan(0);
      const stamped = stamps.map(decoded).join('\n');
      expect(stamped).toMatch(i === 0 ? /\/Image\S* Do/ : /Tj/);
    }
    expect(sealed.getPage(0).getSize()).toEqual(source.getPage(0).getSize());
  });

  it('stamps land where they did before', async () => {
    // Shown 400 wide and 600 tall (a 300x200 crop, turned a quarter, at two units per point).
    await seedCanonicalDocument(state.rows, uploadsDir, 'df1', await geometryPdf());
    // A square box, so the square signature image fills it exactly:
    // x = 0.1 * 400 = 40, width = 0.3 * 400 = 120, height = 0.2 * 600 = 120,
    // y = 600 - 0.2 * 600 - 120 = 360.
    state.envelope = envelopeOver(['df1'], [{ id: 'sig', type: 'SIGNATURE', page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.2 }]);

    const build = await buildSealedEnvelope({ envelopeId: 'env1' });

    const page = (await PDFDocument.load(build.bytes)).getPage(0);
    expect(page.getSize()).toEqual({ width: 400, height: 600 });
    expect(page.node.has(PDFName.of('Rotate'))).toBe(false);
    expect(page.node.has(PDFName.of('CropBox'))).toBe(false);
    // The image is drawn through a unit square; its placement is the product
    // of the `cm` operators between the stamp's q and its Do.
    const stamp = contentStreams(page).map(decoded).find((s) => /\/Image\S* Do/.test(s))!;
    const ops = stamp.slice(stamp.lastIndexOf('q'), stamp.search(/\/Image\S* Do/));
    let ctm = [1, 0, 0, 1, 0, 0];
    for (const m of ops.matchAll(/(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm/g)) {
      const [a, b, c, d, e, f] = m.slice(1).map(Number) as [number, number, number, number, number, number];
      const [A, B, C, D, E, F] = ctm as [number, number, number, number, number, number];
      ctm = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
    }
    expect(ctm.map((n) => Math.round(n * 1000) / 1000)).toEqual([120, 0, 0, 120, 40, 360]);
  });

  it('the seal refuses a canonical file that is not a single-revision pdf-lib file', async () => {
    const { row, canonical } = await seedCanonicalDocument(state.rows, uploadsDir, 'df1', await textPdf(1, 'TERMS'));
    // An appended revision whose bytes the row is then made to name.
    const updated = await appendIncrementalUpdate(canonical, [{ num: 1, body: Buffer.from('<< /Type /Catalog >>') }]);
    const hash = sha256(updated);
    writeFileSync(join(uploadsDir, row.orgId as string, 'canonical', `${hash}.pdf`), updated);
    Object.assign(row, { canonicalStoragePath: `${row.orgId}/canonical/${hash}.pdf`, canonicalSha256: hash });
    state.envelope = envelopeOver(['df1'], [{ id: 'sig', type: 'SIGNATURE', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 }]);

    const err = await buildSealedEnvelope({ envelopeId: 'env1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SealedContentStructureError);
    expect((err as Error).message).toBe("A document's canonical copy is not the file DocuRidge wrote, so it cannot be sealed.");
    expect(signHex).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', (path: string) => rmSync(path)],
    ['changed on disk', (path: string) => writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]))],
  ])('a canonical file that is %s fails the seal, not retryable', async (_name, damage) => {
    const { row } = await seedCanonicalDocument(state.rows, uploadsDir, 'df1', await textPdf(1, `TERMS ${_name}`));
    damage(join(uploadsDir, row.canonicalStoragePath as string));
    state.envelope = envelopeOver(['df1']);

    const err = await buildSealedEnvelope({ envelopeId: 'env1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SealedContentStructureError);
    expect(err).toBeInstanceOf(CanonicalSealSourceError);
    expect((err as InstanceType<typeof CanonicalSealSourceError>).title).toBe('doc-0.pdf');
    expect((err as Error).message).toBe('"doc-0.pdf" could not be prepared for sealing. Replace the document and send it again.');
    // Nothing else was sealed in its place: no job ran, the original was not used.
    expect(runPdfJob).not.toHaveBeenCalled();
  });

  it('the manifest records canonicalSha256 and the result verifies', async () => {
    const { row: a } = await seedCanonicalDocument(state.rows, uploadsDir, 'df1', await textPdf(2, 'FIRST'));
    const { row: b } = await seedCanonicalDocument(state.rows, uploadsDir, 'df2', await textPdf(1, 'SECOND'));
    state.envelope = envelopeOver(['df1', 'df2'], [{ id: 'sig', type: 'SIGNATURE', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 }]);

    const build = await buildSealedEnvelope({ envelopeId: 'env1' });

    const result = await verifySealedPdf(build.bytes, trust());
    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(build.manifest).toMatchObject({
      version: 3,
      documents: [
        // The item rows both say one page; the manifest gives the canonical count.
        { itemOrder: 1, title: 'doc-0.pdf', sourceSha256: a.sha256, canonicalSha256: a.canonicalSha256, pageCount: 2 },
        { itemOrder: 2, title: 'doc-1.pdf', sourceSha256: b.sha256, canonicalSha256: b.canonicalSha256, pageCount: 1 },
      ],
    });
    // The audit page names each document's signed copy in full.
    const sealed = await PDFDocument.load(build.bytes);
    const auditText = contentStreams(sealed.getPage(sealed.getPageCount() - 1))
      .map(decoded).join('\n')
      .replace(/<([0-9A-Fa-f]+)> Tj/g, (_m, hex: string) => Buffer.from(hex, 'hex').toString('latin1'));
    for (const row of [a, b]) expect(auditText).toContain(`signed copy ${row.canonicalSha256}`);
  });

  it('a legacy item without a canonical copy is canonicalized at seal time', async () => {
    const row = seedLegacyDocument(state.rows, uploadsDir, 'df1', await textPdf(1, 'LEGACY'));
    state.envelope = envelopeOver(['df1'], [{ id: 'sig', type: 'SIGNATURE', page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.1 }]);

    const build = await buildSealedEnvelope({ envelopeId: 'env1' });

    const kinds = () => vi.mocked(runPdfJob).mock.calls.map((call) => call[0]);
    expect(kinds()).toEqual(['canonicalize', 'seal']);
    expect(row.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((build.manifest as { documents: Array<{ canonicalSha256: string }> }).documents[0]!.canonicalSha256)
      .toBe(row.canonicalSha256);
    expect((await verifySealedPdf(build.bytes, trust())).ok).toBe(true);

    // The copy is stored: the next seal runs no canonicalize job.
    vi.mocked(runPdfJob).mockClear();
    await buildSealedEnvelope({ envelopeId: 'env1' });
    expect(kinds()).toEqual(['seal']);
  });

  it('a legacy item the canonicalizer refuses fails the seal, not retryable', async () => {
    const original = await (await opaqueSquareOverText()).doc.save({ useObjectStreams: false });
    const row = seedLegacyDocument(state.rows, uploadsDir, 'df1', original);
    state.envelope = envelopeOver(['df1']);

    const err = await buildSealedEnvelope({ envelopeId: 'env1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SealedContentStructureError);
    expect(err).toBeInstanceOf(CanonicalSealSourceError);
    expect((err as InstanceType<typeof CanonicalSealSourceError>).title).toBe('doc-0.pdf');
    expect((err as Error).message).toBe('"doc-0.pdf" could not be prepared for sealing. Replace the document and send it again.');
    expect(row.canonicalRefusal).toBe('visible_annotations');
    expect(vi.mocked(runPdfJob).mock.calls.map((call) => call[0])).toEqual(['canonicalize']);
  });

  it('a busy worker while canonicalizing a legacy item stays retryable', async () => {
    seedLegacyDocument(state.rows, uploadsDir, 'df1', await textPdf(1, 'BUSY'));
    state.envelope = envelopeOver(['df1']);
    vi.mocked(runPdfJob).mockImplementation(async (kind, ...rest) => {
      if (kind === 'canonicalize') throw new PdfWorkerError('busy');
      return realRun(kind, ...rest);
    });

    const err = await buildSealedEnvelope({ envelopeId: 'env1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfWorkerError);
    expect((err as InstanceType<typeof PdfWorkerError>).reason).toBe('busy');
    expect(vi.mocked(runPdfJob).mock.calls.map((call) => call[0])).toEqual(['canonicalize']);
  });

  it('a missing qpdf while canonicalizing an encrypted legacy item is a retryable worker failure', async () => {
    const row = seedLegacyDocument(state.rows, uploadsDir, 'df1', await encryptedPdf('rc4'));
    state.envelope = envelopeOver(['df1']);
    vi.mocked(decryptPdf).mockRejectedValue(new QpdfMissingError());

    const err = await buildSealedEnvelope({ envelopeId: 'env1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfWorkerError);
    expect((err as InstanceType<typeof PdfWorkerError>).reason).toBe('unavailable');
    expect((row as Row).canonicalRefusal).toBeNull();
  });
});
