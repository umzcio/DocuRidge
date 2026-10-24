import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { verifySealedPdf } from './sealed-pdf';
import { checkPdfStructure } from './pdf-structure';
import { sealedContentDigestFromBytes } from '../pdf/content-digest';
import { buildSealedPdf, makeTestKey, type TestKey } from './__fixtures__/sealed-pdf';
import { buildBombPdf, doubleFlate } from '../pdf/__fixtures__/bomb-pdf';
import {
  appendIncrementalUpdate,
  forgedContentStream,
  pageContentRef,
  rewriteSingleRevision,
  serialize,
} from './__fixtures__/pdf-surgery';

const trustOf = (key: TestKey) => ({ publicKeys: [], fingerprints: [key.fingerprint], source: '--fingerprint' });

describe('verifySealedPdf — objects resolved through the cross-reference table', () => {
  let key: TestKey;
  let sealed: Uint8Array;
  let doc: PDFDocument;

  beforeAll(async () => {
    key = await makeTestKey();
    sealed = await buildSealedPdf({ key });
    doc = await PDFDocument.load(sealed);
  });

  it('accepts the genuine seal, which is one revision with an xref stream', async () => {
    await expect(checkPdfStructure(sealed)).resolves.toBeUndefined();
    const result = await verifySealedPdf(sealed, { trust: trustOf(key) });
    expect(result.ok, result.reason).toBe(true);
    expect(result.checks[0]).toMatch(/single revision/);
  });

  it('accepts a single-revision rewrite with a classic xref table', async () => {
    const result = await verifySealedPdf(await rewriteSingleRevision(sealed), { trust: trustOf(key) });
    expect(result.ok, result.reason).toBe(true);
  });

  it('fails with post_seal_revision for an incremental update that shadows a page content stream', async () => {
    // Forged copy first (the new xref points at it, so viewers render it),
    // then a verbatim genuine copy (pdf-lib keeps the last definition).
    const contentRef = pageContentRef(doc);
    const shadowed = await appendIncrementalUpdate(sealed, [
      { num: contentRef.objectNumber, body: forgedContentStream(doc, 'AMOUNT: $1,000,000') },
      { num: contentRef.objectNumber, body: serialize(doc.context.lookup(contentRef)!), listed: false },
    ]);
    // pdf-lib's view, which the digest reads, is unchanged: the digest alone cannot see this.
    expect(await sealedContentDigestFromBytes(shadowed)).toEqual(await sealedContentDigestFromBytes(sealed));

    const result = await verifySealedPdf(shadowed, { trust: trustOf(key), strict: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('post_seal_revision');
  });

  it('fails with post_seal_revision for any appended revision, even one that changes nothing visible', async () => {
    const info = doc.context.trailerInfo.Info as unknown as { objectNumber: number };
    const updated = await appendIncrementalUpdate(sealed, [
      { num: info.objectNumber, body: serialize(doc.context.lookup(doc.context.trailerInfo.Info!)!) },
    ]);
    expect((await verifySealedPdf(updated)).code).toBe('post_seal_revision');
  });

  it('fails with post_seal_revision for bytes after the final %%EOF', async () => {
    const trailing = Buffer.concat([Buffer.from(sealed), Buffer.from('\n1 0 obj\n(x)\nendobj\n', 'latin1')]);
    expect((await verifySealedPdf(trailing)).code).toBe('post_seal_revision');
  });

  it('fails with duplicate_object when one revision defines an object twice', async () => {
    // The variant without an incremental update: the forged copy sits before
    // the genuine one and the rebuilt xref points at it.
    const contentRef = pageContentRef(doc);
    const forged = await rewriteSingleRevision(sealed, {
      before: new Map([[contentRef.objectNumber, forgedContentStream(doc, 'AMOUNT: $1,000,000')]]),
    });
    expect(await sealedContentDigestFromBytes(forged)).toEqual(await sealedContentDigestFromBytes(sealed));

    const result = await verifySealedPdf(forged, { trust: trustOf(key), strict: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('duplicate_object');
  });

  it('fails with xref_mismatch when the xref resolves an object inside another object\'s stream data', async () => {
    // One definition per object number as pdf-lib parses it; the forged
    // content stream hides inside an unreferenced stream's bytes, where only
    // a reader following the xref offset finds it.
    const contentRef = pageContentRef(doc);
    const hidden = Buffer.concat([
      Buffer.from(`${contentRef.objectNumber} 0 obj\n`, 'latin1'),
      forgedContentStream(doc, 'AMOUNT: $1,000,000'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    const carrier = serialize(doc.context.stream(hidden));
    const carrierNum = doc.context.largestObjectNumber + 1;
    const forged = await rewriteSingleRevision(sealed, {
      extra: [{ num: carrierNum, body: carrier }],
      xrefOffset: (num, offsets) => num === contentRef.objectNumber
        ? offsets.get(`${carrierNum}:extra`)! + `${carrierNum} 0 obj\n`.length + carrier.indexOf(hidden)
        : undefined,
    });
    expect(await sealedContentDigestFromBytes(forged)).toEqual(await sealedContentDigestFromBytes(sealed));

    const result = await verifySealedPdf(forged, { trust: trustOf(key) });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('xref_mismatch');
  });

  it('fails with xref_mismatch when an xref entry does not point at the start of its object', async () => {
    const contentRef = pageContentRef(doc);
    const bytes = await rewriteSingleRevision(sealed, {
      xrefOffset: (num, offsets) => (num === contentRef.objectNumber ? offsets.get(String(num))! + 1 : undefined),
    });
    expect((await verifySealedPdf(bytes)).code).toBe('xref_mismatch');
  });

  it('keeps reporting decode_limit for a decompression bomb, not a structure error', async () => {
    const result = await verifySealedPdf(buildBombPdf('objstm', doubleFlate(160 * 1024 * 1024)));
    expect(result.code).toBe('decode_limit');
  });

  it('applies to legacy digest versions too', async () => {
    for (const digestVersion of [1, 2] as const) {
      const legacy = await buildSealedPdf({ key, digestVersion });
      expect((await verifySealedPdf(legacy, { trust: trustOf(key) })).ok).toBe(true);
      const legacyDoc = await PDFDocument.load(legacy);
      const contentRef = pageContentRef(legacyDoc);
      const shadowed = await appendIncrementalUpdate(legacy, [
        { num: contentRef.objectNumber, body: forgedContentStream(legacyDoc, 'VOID') },
        { num: contentRef.objectNumber, body: serialize(legacyDoc.context.lookup(contentRef)!), listed: false },
      ]);
      expect((await verifySealedPdf(shadowed, { trust: trustOf(key) })).code).toBe('post_seal_revision');
    }
  });
});
