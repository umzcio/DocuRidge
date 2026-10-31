import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream, degrees, type PDFPage } from 'pdf-lib';

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
import { SealedContentStructureError } from './page-tree';
import { checkPdfStructure } from '../verify/pdf-structure';
import { verifySealedPdf } from '../verify/sealed-pdf';
import { makeTestKey, solidPng, type TestKey } from '../verify/__fixtures__/sealed-pdf';
import { UNEMBEDDABLE_VARIANTS, pageTreeVariantPdf } from './__fixtures__/page-tree-variants-pdf';
import { canonicalizeUploadedPdf } from './canonicalize';

const MiB = 1024 * 1024;
let key: TestKey;

beforeAll(async () => {
  key = await makeTestKey();
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

/** The canonical copy of `original`, as upload stores it: what the seal is handed. */
async function canonical(original: Uint8Array): Promise<Uint8Array> {
  const result = await canonicalizeUploadedPdf(original);
  if (!result.ok) throw new Error(`the fixture was refused: ${result.key}`);
  return result.bytes;
}

/** The canonical copy of a `pages`-page document with a line of text on each page. */
async function sourcePdf(pages: number, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${text} page ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return canonical(await doc.save());
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

/** One page whose /Resources reach an indirect array of `elements` numbers, saved in an object stream. */
async function objectStreamPdf(elements: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const big = doc.context.register(doc.context.obj(Array.from({ length: elements }, (_, i) => 100000 + i)));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Big: big }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q Q')));
  return doc.save({ useObjectStreams: true });
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
      items: items.map((_, i) => ({ title: `doc-${i}.pdf`, documentFile: { sha256: 'a'.repeat(64) }, canonicalSha256: 'c'.repeat(64) })),
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

    const result = await verifySealedPdf(bytes, { ...trust(), strict: true });
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
    'seals the canonical copy of a source whose page tree has a %s defect that every reader reads alike',
    async (variant) => {
      const bytes = await renderSealedEnvelope(
        input([{ bytes: await canonical(await pageTreeVariantPdf(variant)), fields: [field('SIGNATURE', 2), field('TEXT', 1, 'Hi')] }]),
        signer(),
      );

      const result = await verifySealedPdf(bytes, trust());
      expect(result.reason).toBeUndefined();
      expect(result.ok).toBe(true);
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3); // 2 source pages + audit page
    },
  );

  it.each(['missing_parent', 'stale_parent', 'root_count_high'] as const)(
    'refuses a file that is not a canonical copy: a page tree with a %s defect, before asking for a signature',
    async (variant) => {
      const sign = vi.fn(signer());
      const err = await renderSealedEnvelope(
        input([{ bytes: await pageTreeVariantPdf(variant), fields: [field('SIGNATURE', 1)] }]),
        sign,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SealedContentStructureError);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it('seals the canonical copy of a source whose pages inherit /MediaBox from the root', async () => {
    const bytes = await renderSealedEnvelope(
      input([{ bytes: await canonical(await pageTreeVariantPdf('root_mediabox')), fields: [field('SIGNATURE', 2)] }]),
      signer(),
    );
    expect((await verifySealedPdf(bytes, trust())).ok).toBe(true);
  });

  it('seals the canonical copy of a source page with a zero-area /CropBox at its /MediaBox size', async () => {
    const bytes = await renderSealedEnvelope(
      input([{ bytes: await canonical(await pageTreeVariantPdf('zero_area_cropbox')), fields: [field('SIGNATURE', 2)] }]),
      signer(),
    );
    expect((await verifySealedPdf(bytes, trust())).ok).toBe(true);
    const sealed = await PDFDocument.load(bytes);
    expect(sealed.getPageCount()).toBe(3);
    expect(sealed.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
  });

  it.each(['missing_parent_root_mediabox', 'no_mediabox', 'rotate_not_number'] as const)(
    'refuses a source with %s as a page-structure error, before asking for a signature',
    async (variant) => {
      const sign = vi.fn(signer());
      const err = await renderSealedEnvelope(
        input([{ bytes: await pageTreeVariantPdf(variant), fields: [field('SIGNATURE', 1)] }]),
        sign,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SealedContentStructureError);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a /Rotate', (page: PDFPage) => page.setRotation(degrees(90))],
    ['a /CropBox', (page: PDFPage) => page.setCropBox(0, 0, 300, 300)],
    ['a /MediaBox off the origin', (page: PDFPage) => page.setMediaBox(10, 10, 612, 792)],
    ['a /UserUnit', (page: PDFPage) => page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))],
    // Entries the copy would carry into the seal, which a canonical page never has.
    ['a page /AA', (page: PDFPage) => page.node.set(PDFName.of('AA'), page.doc.context.obj({}))],
    ['an annotation', (page: PDFPage) => page.node.set(PDFName.of('Annots'), page.doc.context.obj([
      page.doc.context.register(page.doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] })),
    ]))],
  ] as const)('refuses a canonical copy rewritten with %s, which is not what canonicalization writes', async (_name, edit) => {
    const doc = await PDFDocument.load(await sourcePdf(1, 'doc'), { updateMetadata: false });
    edit(doc.getPage(0));
    const sign = vi.fn(signer());

    const err = await renderSealedEnvelope(
      input([{ bytes: await doc.save({ useObjectStreams: false }), fields: [field('SIGNATURE', 1)] }]),
      sign,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SealedContentStructureError);
    expect((err as Error).message).toBe("A document's canonical copy is not the file DocuRidge wrote, so it cannot be sealed.");
    expect(sign).not.toHaveBeenCalled();
  });

  // A file whose bytes match its row but that this code did not write (a
  // compromised canonicalize worker, or storage edited with its row): pdf-lib
  // copies these pages as they are, then throws at the first stamp.
  it.each([...UNEMBEDDABLE_VARIANTS, 'resources_not_dict'] as const)(
    'refuses a stored file with %s on a stamped page as a canonical-copy structure error',
    async (variant) => {
      const sign = vi.fn(signer());
      const err = await renderSealedEnvelope(
        input([{ bytes: await pageTreeVariantPdf(variant), fields: [field('SIGNATURE', 2)] }]),
        sign,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SealedContentStructureError);
      expect((err as Error).message).toBe("A document's canonical copy is not the file DocuRidge wrote, so it cannot be sealed.");
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it('seals the canonical copy of a page without /Contents whose /Resources is not a dictionary', async () => {
    const bytes = await renderSealedEnvelope(
      input([{ bytes: await canonical(await pageTreeVariantPdf('no_contents_resources_not_dict')), fields: [field('SIGNATURE', 1)] }]),
      signer(),
    );
    expect((await verifySealedPdf(bytes, trust())).ok).toBe(true);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
  });

  it.each([3, 0])('refuses a field on page %i of a two-page document instead of dropping it', async (page) => {
    const err = await renderSealedEnvelope(
      input([{ bytes: await sourcePdf(2, 'doc'), fields: [field('SIGNATURE', 1), field('TEXT', page, 'lost')] }]),
      signer(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SealedContentStructureError);
    expect((err as Error).message).toBe('A field is on a page its document does not have, so the envelope cannot be sealed.');
  });

  it('does not turn an error in its own code into a structure error', async () => {
    const err = await renderSealedEnvelope(
      input([{ bytes: await sourcePdf(1, 'doc'), fields: [field('SIGNATURE', 1)] }], {
        // Input our own code cannot read: our bug, not the source's.
        recipients: null as unknown as SealRenderInput['recipients'],
      }),
      signer(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SealedContentStructureError);
  });

  it('keeps the per-document decode budget: documents that each fit seal together', async () => {
    vi.stubEnv('PDF_MAX_DECODED_STREAM_BYTES', String(4 * MiB));
    vi.stubEnv('PDF_MAX_DECODED_TOTAL_BYTES', String(4 * MiB));
    const items = [];
    for (let i = 0; i < 3; i++) items.push({ bytes: await canonical(await pdfWithHeavyPages(1, 3 * MiB)), fields: [] });

    const bytes = await renderSealedEnvelope(input(items), signer());

    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4);
  });

  it('refuses a document whose object streams decode past one budget, before asking for a signature', async () => {
    // A canonical copy has no object streams and the copy decodes no page
    // content, but a stored file that is not one is still parsed under the
    // budget.
    vi.stubEnv('PDF_MAX_DECODED_TOTAL_BYTES', String(256 * 1024));
    const sign = vi.fn(signer());

    const err = await renderSealedEnvelope(input([{ bytes: await objectStreamPdf(150_000), fields: [] }]), sign)
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

/** Each text line drawn on `page`: its font size, position and text. */
function auditTextLines(page: PDFPage): Array<{ size: number; x: number; y: number; text: string }> {
  const contents = page.node.get(PDFName.of('Contents'));
  const resolved = page.doc.context.lookup(contents);
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [contents];
  const ops = refs
    .map((ref) => page.doc.context.lookup(ref))
    .map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString('latin1'))
    .join('\n');
  return [...ops.matchAll(/\/\S+ (\S+) Tf\n\S+ TL\n1 0 0 1 (\S+) (\S+) Tm\n<([0-9A-Fa-f]*)> Tj/g)].map((m) => ({
    size: Number(m[1]), x: Number(m[2]), y: Number(m[3]), text: Buffer.from(m[4]!, 'hex').toString('latin1'),
  }));
}

describe('the audit page', () => {
  it('fits a full envelope on one page: 25 documents with their signed-copy hashes, 10 recipients, then the events', async () => {
    const bytes = await sourcePdf(1, 'doc');
    // A 52-character title fits in full; the old line (with a 12-hex upload
    // hash and a longer label) cut titles near 25 characters.
    const MEDIUM = 'Master services agreement - signed copy (final).pdf';
    const titles = Array.from({ length: 25 }, (_, i) =>
      (i === 3 ? `A very long title ${'x'.repeat(300)}.pdf` : i === 4 ? MEDIUM : `doc-${i}.pdf`));
    const recipients = Array.from({ length: 10 }, (_, i) => ({
      name: `Recipient ${i}`, email: `r${i}@example.com`, signingStatus: 'SIGNED', signedAt: new Date('2026-10-24T15:20:00Z'),
    }));
    const base = input(titles.map(() => ({ bytes, fields: [] })));
    const sealed = await PDFDocument.load(await renderSealedEnvelope({
      ...base,
      auditPage: {
        ...base.auditPage,
        items: titles.map((title, i) => ({
          title, documentFile: { sha256: 'a'.repeat(64) }, canonicalSha256: i.toString(16).padStart(64, 'c'),
        })),
        recipients,
        auditEvents: Array.from({ length: 5 }, (_, i) => ({
          createdAt: new Date(`2026-10-24T15:0${i}:00Z`), type: `event.${i}`, actorEmail: 'sender@example.com', actorName: null,
        })),
      },
    }, signer()));

    expect(sealed.getPageCount()).toBe(26); // one audit page
    const page = sealed.getPage(25);
    const lines = auditTextLines(page);
    const helv = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    for (const line of lines) {
      expect(line.y, line.text).toBeGreaterThanOrEqual(60);
      // Every line stays inside the right margin (headings, in bold, are short).
      expect(line.x + helv.widthOfTextAtSize(line.text, line.size), line.text).toBeLessThanOrEqual(page.getWidth() - 50);
    }
    const texts = lines.map((l) => l.text);
    for (const [i, title] of titles.entries()) {
      const hash = i.toString(16).padStart(64, 'c');
      const line = texts.find((t) => t.endsWith(`  signed copy ${hash}`));
      expect(line, title).toBeDefined();
      // The upload's hash is in the manifest, not on this line.
      expect(line).not.toContain('a'.repeat(12));
      if (i === 3) expect(line).toMatch(/^- A very long title x+\.\.\.  signed copy /);
      else expect(line).toBe(`- ${title}  signed copy ${hash}`);
    }
    for (const r of recipients) expect(texts.some((t) => t.startsWith(`- ${r.name} <${r.email}>`)), r.name).toBe(true);
    expect(texts).toContain('Events');
    for (let i = 0; i < 5; i++) expect(texts.some((t) => t.includes(`event.${i}`))).toBe(true);
  });
});

describe('stored text the WinAnsi fonts cannot encode', () => {
  // Signers and senders can store control characters (a pasted tab, C1
  // controls, DEL). The seal runs after the last signature has committed, so
  // it must draw them, replaced, rather than fail every retry.
  it.each([
    ['tab', '\t', ' '],
    ['DEL', '\u007f', '?'],
    ['NEL (U+0085)', '\u0085', ' '],
    ['U+0090', '\u0090', '?'],
  ])('seals with a %s in field values, a typed signature, names, titles and filenames', async (_name, ch, shown) => {
    const t = (s: string) => `${s}${ch}x`;
    const base = input(
      [{
        bytes: await sourcePdf(1, 'doc'),
        fields: [
          field('SIGNATURE', 1), field('INITIALS', 1), field('TEXT', 1, t('Text')), field('ADDRESS', 1, `${t('Line 1')}\n${t('Line 2')}`),
          field('DATE', 1, t('2026-10-24')), field('NAME', 1), field('EMAIL', 1), field('COMPANY', 1, t('Co')),
          field('NOTE', 1, null, { meta: { noteText: t('Note') } }),
        ],
      }],
      {
        recipients: [{
          id: 'r1', name: t('Alice'), email: t('alice@example.com'),
          signatures: [
            { imagePngBase64: null, typedSignature: t('Alice Signer'), fieldId: 'f-sig' },
            { imagePngBase64: null, typedSignature: t('AS'), fieldId: 'f-ini' },
          ],
        }],
        fieldsById: { 'f-sig': { type: 'SIGNATURE' }, 'f-ini': { type: 'INITIALS' } },
      },
    );
    for (const fieldFont of ['sans', 'serif', 'mono'] as const) {
      const bytes = await renderSealedEnvelope({
        ...base,
        fieldFont,
        auditPage: {
          ...base.auditPage,
          title: t('Contract'),
          createdBy: { name: t('Sender'), email: t('sender@example.com') },
          org: { name: t('Org') },
          items: [{ title: t('doc.pdf'), documentFile: { sha256: 'a'.repeat(64) }, canonicalSha256: 'c'.repeat(64) }],
          recipients: [{ name: t('Alice'), email: t('alice@example.com'), signingStatus: 'SIGNED', signedAt: new Date('2026-10-24T15:20:00Z') }],
          fields: [{ type: 'ATTACHMENT', recipient: { name: t('Alice') }, attachment: { filename: t('scan.pdf'), sha256: 'b'.repeat(64), sizeBytes: 2048 } }],
          auditEvents: [{ createdAt: new Date('2026-10-24T15:00:00Z'), type: 'envelope.created', actorEmail: null, actorName: t('Sender') }],
        },
      }, signer());

      expect((await verifySealedPdf(bytes, trust())).ok).toBe(true);
      const sealed = await PDFDocument.load(bytes);
      const texts = auditTextLines(sealed.getPage(1)).map((l) => l.text);
      expect(texts).toContain(`Envelope: Contract${shown}x`);
      expect(texts.some((line) => line.startsWith(`- scan.pdf${shown}x  2 KB`))).toBe(true);
    }
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
