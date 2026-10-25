import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

// The render runs in the sandboxed PDF worker: it must not load the database,
// the env loader, keys, the audit chain or the logger. Importing any of them
// fails this file.
vi.mock('../prisma', () => { throw new Error('seal-render must not import ../prisma'); });
vi.mock('../env', () => { throw new Error('seal-render must not import ../env'); });
vi.mock('../logger', () => { throw new Error('seal-render must not import ../logger'); });
vi.mock('../crypto/org-key', () => { throw new Error('seal-render must not import ../crypto/org-key'); });
vi.mock('../audit/envelope', () => { throw new Error('seal-render must not import ../audit/envelope'); });

import { renderSealedEnvelope, runSealJob, type SealRenderInput, type SealRenderWarning } from './seal-render';
import { canonicalJson, hexToBytes, sha256Hex } from '../audit/canonical';
import { sealedContentDigestFromBytes, type SealedContentDigest } from './content-digest';
import { PdfDecodeLimitError } from './decode-limits';
import { PdfComplexityError } from './seal-limits';
import { checkPdfStructure } from '../verify/pdf-structure';
import { verifySealedPdf } from '../verify/sealed-pdf';
import { makeTestKey, solidPng, type TestKey } from '../verify/__fixtures__/sealed-pdf';
import { pageTreeVariantPdf } from './__fixtures__/page-tree-variants-pdf';

const MiB = 1024 * 1024;
let key: TestKey;

beforeAll(async () => {
  key = await makeTestKey();
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

async function sourcePdf(pages: number, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${text} page ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return doc.save();
}

/** A PDF whose pages each carry a content stream decoding to `decodedBytes`. */
async function pdfWithHeavyPages(pageCount: number, decodedBytes: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(Buffer.alloc(decodedBytes, 0x20))));
  }
  return doc.save();
}

function input(items: SealRenderInput['items'], extra: Partial<SealRenderInput> = {}): SealRenderInput {
  return {
    fieldFont: 'sans',
    items,
    recipients: [{
      id: 'r1', name: 'Alice Signer', email: 'alice@example.com',
      signatures: [{ imagePngBase64: solidPng(20, 20, 20, 8).toString('base64'), typedSignature: 'Alice Signer', fieldId: 'f-sig' }],
    }],
    fieldsById: { 'f-sig': { type: 'SIGNATURE' } },
    auditPage: {
      id: 'env1', title: 'Contract',
      createdBy: { name: 'Sender', email: 'sender@example.com' },
      org: { name: 'Org' },
      items: items.map((_, i) => ({ title: `doc-${i}.pdf`, documentFile: { sha256: 'a'.repeat(64) } })),
      recipients: [{ name: 'Alice Signer', email: 'alice@example.com', signingStatus: 'SIGNED', signedAt: new Date('2026-10-24T15:20:00Z') }],
      fields: [],
      auditEvents: [{ createdAt: new Date('2026-10-24T15:00:00Z'), type: 'envelope.created', actorEmail: 'sender@example.com', actorName: null }],
    },
    ...extra,
  };
}

const field = (type: string, page: number, value: string | null = null, extra: Record<string, unknown> = {}) => ({
  type, page, x: 0.1, y: 0.1 + page * 0.01, w: 0.3, h: 0.05, value, recipientId: 'r1', meta: null, ...extra,
});

/** What the parent does: a manifest over `sealedContent`, signed with the test key, as JSON bytes. */
function signer(calls: SealedContentDigest[] = []) {
  return async (sealedContent: SealedContentDigest): Promise<Uint8Array> => {
    calls.push(sealedContent);
    const manifest = {
      version: 3,
      generator: 'DocuRidge',
      envelope: { id: 'env1', orgId: 'org1', title: 'Contract', sentAt: null, completedAt: null },
      signedBy: { keyId: 'key1', fingerprint: key.fingerprint, algorithm: 'ed25519', publicKeyPem: key.publicKeyPem },
      documents: [],
      sealedContent,
      recipients: [],
      auditChain: { head: null, length: 0, events: [] },
    };
    const manifestSha256 = await sha256Hex(canonicalJson({ ...manifest, manifestSha256: undefined, manifestSignature: undefined }));
    const manifestSignature = Buffer.from(await ed.signAsync(hexToBytes(manifestSha256), key.privateKey)).toString('hex');
    return new TextEncoder().encode(JSON.stringify({ ...manifest, manifestSha256, manifestSignature }));
  };
}

const trust = () => ({ trust: { publicKeys: [], fingerprints: [key.fingerprint], source: 'test' } });

describe('renderSealedEnvelope', () => {
  it('renders a two-document envelope that the verifier accepts with the fixture key', async () => {
    const calls: SealedContentDigest[] = [];
    const bytes = await renderSealedEnvelope(
      input([
        { bytes: await sourcePdf(2, 'first'), fields: [field('SIGNATURE', 1), field('TEXT', 2, 'Hello'), field('CHECKBOX', 2, 'true')] },
        { bytes: await sourcePdf(1, 'second'), fields: [field('DATE', 1, '2026-10-24'), field('NAME', 1)] },
      ]),
      signer(calls),
    );

    const result = await verifySealedPdf(bytes, trust());
    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4); // 3 source pages + audit page
    await expect(checkPdfStructure(bytes)).resolves.toBeUndefined();
    // Exactly one signing request, over the digest of the body as rendered.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(await sealedContentDigestFromBytes(bytes));
    expect(calls[0]).toMatchObject({ algorithm: 'sha256', digestVersion: 3, pageCount: 4 });
  });

  it.each(['missing_parent', 'stale_parent', 'root_count_high'] as const)(
    'seals a source whose page tree has a %s defect that every reader reads alike',
    async (variant) => {
      const bytes = await renderSealedEnvelope(
        input([{ bytes: await pageTreeVariantPdf(variant), fields: [field('SIGNATURE', 2), field('TEXT', 1, 'Hi')] }]),
        signer(),
      );

      const result = await verifySealedPdf(bytes, trust());
      expect(result.reason).toBeUndefined();
      expect(result.ok).toBe(true);
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3); // 2 source pages + audit page
    },
  );

  it('keeps the per-document decode budget: documents that each fit seal together', async () => {
    vi.stubEnv('PDF_MAX_DECODED_STREAM_BYTES', String(4 * MiB));
    vi.stubEnv('PDF_MAX_DECODED_TOTAL_BYTES', String(4 * MiB));
    const items = [];
    for (let i = 0; i < 3; i++) items.push({ bytes: await pdfWithHeavyPages(1, 3 * MiB), fields: [] });

    const bytes = await renderSealedEnvelope(input(items), signer());

    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4);
  });

  it('refuses a single document whose pages decode past one budget', async () => {
    vi.stubEnv('PDF_MAX_DECODED_STREAM_BYTES', String(4 * MiB));
    vi.stubEnv('PDF_MAX_DECODED_TOTAL_BYTES', String(4 * MiB));
    const sign = vi.fn(signer());

    const err = await renderSealedEnvelope(input([{ bytes: await pdfWithHeavyPages(2, 3 * MiB), fields: [] }]), sign)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('total');
    expect(sign).not.toHaveBeenCalled();
  });

  it('refuses an envelope with more documents than the item cap before parsing any', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_ITEMS', '2');
    const items = [];
    for (let i = 0; i < 3; i++) items.push({ bytes: new Uint8Array([1, 2, 3]), fields: [] });

    const err = await renderSealedEnvelope(input(items), signer()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('envelope_items');
  });

  it('returns an image that cannot be embedded as a structured warning and falls back to the typed signature', async () => {
    const warnings: SealRenderWarning[] = [];
    const broken = Buffer.from('not an image').toString('base64');
    const bytes = await renderSealedEnvelope(
      input(
        [{ bytes: await sourcePdf(1, 'doc'), fields: [field('SIGNATURE', 1), field('DRAWING', 1, broken), field('STAMP', 1, null, { meta: { stampImageBase64: broken } })] }],
        {
          recipients: [{ id: 'r1', name: 'Alice', email: 'alice@example.com', signatures: [{ imagePngBase64: broken, typedSignature: 'Alice', fieldId: null }] }],
        },
      ),
      signer(),
      { onWarning: (w) => warnings.push(w) },
    );

    expect((await verifySealedPdf(bytes, trust())).ok).toBe(true);
    expect(warnings).toEqual([
      { kind: 'signature_image_embed_failed', recipientId: 'r1', fieldType: 'SIGNATURE' },
      { kind: 'drawing_image_embed_failed', recipientId: 'r1', fieldType: 'DRAWING' },
      { kind: 'stamp_image_embed_failed', recipientId: 'r1', fieldType: 'STAMP' },
    ]);
  });
});

describe('runSealJob (the worker handler)', () => {
  it('asks the parent once for the signed manifest and returns the bytes and warnings', async () => {
    const sign = signer();
    const askParent = vi.fn(async (body: unknown) => sign((body as { sealedContent: SealedContentDigest }).sealedContent));

    const out = await runSealJob(input([{ bytes: await sourcePdf(1, 'doc'), fields: [field('SIGNATURE', 1)] }]), { askParent });

    expect(askParent).toHaveBeenCalledTimes(1);
    expect(Object.keys(askParent.mock.calls[0]![0] as object)).toEqual(['sealedContent']);
    expect(out.warnings).toEqual([]);
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect((await verifySealedPdf(out.bytes, trust())).ok).toBe(true);
  });

  it('fails when the parent answers with something other than manifest bytes', async () => {
    const err = await runSealJob(
      input([{ bytes: await sourcePdf(1, 'doc'), fields: [] }]),
      { askParent: async () => 'not bytes' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/signed manifest/);
  });
});
