import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { verifySealedPdf } from './sealed-pdf';
import { checkPdfStructure } from './pdf-structure';
import { sealedContentDigestFromBytes } from '../pdf/content-digest';
import { buildSealedPdf, makeTestKey, type TestKey } from './__fixtures__/sealed-pdf';
import { buildBombPdf, doubleFlate } from '../pdf/__fixtures__/bomb-pdf';
import {
  appendIncrementalUpdate,
  forgedContentStream,
  objectBodies,
  pageContentRef,
  rewriteSingleRevision,
  serialize,
  streamBody,
  writeClassic,
  writeWithObjectStream,
  type ObjectBody,
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

/** Rewrite `body` as latin1 text. */
const edit = (body: Buffer, fn: (text: string) => string): Buffer => Buffer.from(fn(body.toString('latin1')), 'latin1');

/** Add entries at the end of a (non-stream) dictionary body. */
const appendToDict = (body: Buffer, entries: string): Buffer => edit(body, (t) => t.replace(/>>\s*$/, `${entries}\n>>`));

describe('verifySealedPdf — shapes pdf.js reads differently from pdf-lib', () => {
  let key: TestKey;
  let sealed: Uint8Array;
  let doc: PDFDocument;
  let objects: ObjectBody[];
  let trailer: string;

  /** The genuine objects with `num`'s body replaced. */
  const withBody = (num: number, fn: (body: Buffer) => Buffer): ObjectBody[] =>
    objects.map((o) => (o.num === num ? { num, body: fn(o.body) } : o));
  const nextNumber = (): number => Math.max(...objects.map((o) => o.num)) + 1;
  const verify = async (bytes: Uint8Array) => verifySealedPdf(bytes, { trust: trustOf(key), strict: true });

  beforeAll(async () => {
    key = await makeTestKey();
    sealed = await buildSealedPdf({ key });
    ({ doc, objects, trailer } = await objectBodies(sealed));
  });

  it('accepts the genuine seal rewritten by these helpers, in either layout', async () => {
    expect((await verify(writeClassic(objects, trailer))).ok).toBe(true);
    const font = fontRef(doc).objectNumber;
    const inStream = writeWithObjectStream(objects.filter((o) => o.num !== font), {
      num: nextNumber(),
      members: [objects.find((o) => o.num === font)!],
    }, trailer);
    const result = await verify(inStream);
    expect(result.ok, result.reason).toBe(true);
  });

  describe('stream framing (stream_framing)', () => {
    const STREAM_EDITS: [string, (body: Buffer) => Buffer][] = [
      ['no EOL after the stream keyword', (b) => edit(b, (t) => t.replace('\nstream\n', '\nstream'))],
      ['a space before the EOL', (b) => edit(b, (t) => t.replace('\nstream\n', '\nstream \r\n'))],
      ['a lone CR after the stream keyword', (b) => edit(b, (t) => t.replace('\nstream\n', '\nstream\r'))],
      // pdf-lib then scans for endstream instead of trusting /Length.
      ['a /Length short of the data', (b) => edit(b, (t) => t.replace(/\/Length (\d+)/, (_m, n: string) => `/Length ${Number(n) - 1}`))],
      ['a comment between the data and endstream', (b) => edit(b, (t) => t.replace(/\nendstream$/, '\n% x\nendstream'))],
      ['bytes between endstream and endobj', (b) => Buffer.concat([b, Buffer.from(' x', 'latin1')])],
    ];

    for (const [name, change] of STREAM_EDITS) {
      it(`refuses ${name} on the page content stream`, async () => {
        const result = await verify(writeClassic(withBody(pageContentRef(doc).objectNumber, change), trailer));
        expect(result.ok).toBe(false);
        expect(result.code).toBe('stream_framing');
      });
    }

    it('refuses a bare stream keyword even though the digest is unchanged', async () => {
      // pdf-lib still starts the data right after `stream`; pdf.js skips to
      // the first EOL, so it decodes a different window (here: nothing).
      const bare = writeClassic(withBody(pageContentRef(doc).objectNumber, STREAM_EDITS[0]![1]), trailer);
      expect(await sealedContentDigestFromBytes(bare)).toEqual(await sealedContentDigestFromBytes(sealed));
      expect((await verify(bare)).code).toBe('stream_framing');
    });

    it('refuses an indirect /Length', async () => {
      const lengthNum = nextNumber();
      let length = '';
      const changed = withBody(pageContentRef(doc).objectNumber, (b) => edit(b, (t) => t.replace(/\/Length (\d+)/, (_m, n: string) => {
        length = n;
        return `/Length ${lengthNum} 0 R`;
      })));
      const result = await verify(writeClassic([...changed, { num: lengthNum, body: Buffer.from(length, 'latin1') }], trailer));
      expect(result.code).toBe('stream_framing');
    });

    it('refuses a stream nested inside another object', async () => {
      const info = (doc.context.trailerInfo.Info as PDFRef).objectNumber;
      const nested = withBody(info, (b) => appendToDict(b, `/X ${streamBody('<< /Length 3 >>', 'q Q').toString('latin1')}`));
      expect((await verify(writeClassic(nested, trailer))).code).toBe('stream_framing');
    });
  });

  describe('cross-reference shape (xref_malformed)', () => {
    it('refuses a subsection whose count is not the number of entries that follow', async () => {
      // pdf-lib ignores the count; pdf.js rejects the table and re-indexes
      // every `N 0 obj` in the file, where a hidden copy can win.
      const result = await verify(writeClassic(objects, trailer, { xrefHeader: '0 1' }));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('xref_malformed');
    });

    it('refuses an object 0 listed as in use', async () => {
      expect((await verify(writeClassic(objects, trailer, { objectZero: '0000000000 65535 n ' }))).code).toBe('xref_malformed');
    });

    it('refuses an entry that is not 20 bytes', async () => {
      expect((await verify(writeClassic(objects, trailer, { objectZero: '0000000000 65535 f' }))).code).toBe('xref_malformed');
    });

    it('refuses a /Size that does not cover every listed object', async () => {
      expect((await verify(writeClassic(objects, trailer, { size: 2 }))).code).toBe('xref_malformed');
    });

    it('refuses a linearization dictionary as the first object', async () => {
      const lin = { num: nextNumber(), body: Buffer.from('<< /Linearized 1 /L 1 /N 1 /O 1 /E 0 /T 0 /H [0 0] >>', 'latin1') };
      expect((await verify(writeClassic([lin, ...objects], trailer))).code).toBe('xref_malformed');
    });

    it('refuses an xref stream whose /Index describes more entries than it holds', async () => {
      const font = fontRef(doc).objectNumber;
      const bytes = writeWithObjectStream(objects.filter((o) => o.num !== font), {
        num: nextNumber(),
        members: [objects.find((o) => o.num === font)!],
      }, trailer, { xrefDict: (d) => d.replace(/\/Index \[0 (\d+)\]/, (_m, n: string) => `/Index [0 ${Number(n) + 1}]`) });
      expect((await verify(bytes)).code).toBe('xref_malformed');
    });
  });

  describe('name spelling (name_encoding)', () => {
    /** A forged one-page document: catalog, page tree, page, content. */
    const forgedDocument = (first: number, parent?: number): ObjectBody[] => {
      const [catalog, pages, page, content] = [first, first + 1, first + 2, first + 3];
      return [
        { num: catalog, body: Buffer.from(`<< /Type /Catalog /Pages ${pages} 0 R >>`, 'latin1') },
        { num: pages, body: Buffer.from(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`, 'latin1') },
        { num: page, body: Buffer.from(`<< /Type /Page /Parent ${parent ?? pages} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R >>`, 'latin1') },
        { num: content, body: streamBody('<< /Length 25 >>', '1 0 0 rg 0 0 612 792 re f') },
      ];
    };

    it('refuses a trailer /R#6fot (Root to pdf.js only) pointing at a forged catalog', async () => {
      const first = nextNumber();
      const forged = writeClassic([...objects, ...forgedDocument(first)], `${trailer} /R#6fot ${first} 0 R`);
      expect(await sealedContentDigestFromBytes(forged)).toEqual(await sealedContentDigestFromBytes(sealed));
      const result = await verify(forged);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('name_encoding');
      expect(result.reason).toContain('/R#6fot');
    });

    it('refuses /#4bids on the root /Pages node of a v2 seal', async () => {
      const v2 = await objectBodies(await buildSealedPdf({ key, digestVersion: 2 }));
      const root = (v2.doc.catalog.get(PDFName.of('Pages')) as PDFRef).objectNumber;
      const first = Math.max(...v2.objects.map((o) => o.num)) + 1;
      const forged = [
        ...v2.objects.map((o) => (o.num === root ? { num: root, body: appendToDict(o.body, `/#4bids [${first + 2} 0 R]`) } : o)),
        ...forgedDocument(first, root).slice(2),
      ];
      const result = await verifySealedPdf(writeClassic(forged, v2.trailer), { trust: trustOf(key) });
      expect(result.code).toBe('name_encoding');
    });

    it('refuses /C#6fntents on a page of a v1 seal', async () => {
      const v1 = await objectBodies(await buildSealedPdf({ key, digestVersion: 1 }));
      const page = v1.doc.getPage(0).ref.objectNumber;
      const content = Math.max(...v1.objects.map((o) => o.num)) + 1;
      const forged = [
        ...v1.objects.map((o) => (o.num === page ? { num: page, body: appendToDict(o.body, `/C#6fntents ${content} 0 R`) } : o)),
        { num: content, body: streamBody('<< /Length 25 >>', '1 0 0 rg 0 0 612 792 re f') },
      ];
      const result = await verifySealedPdf(writeClassic(forged, v1.trailer), { trust: trustOf(key) });
      expect(result.code).toBe('name_encoding');
    });

    it('refuses a needless upper-case escape, though pdf-lib reads the same name', async () => {
      const catalog = (doc.context.trailerInfo.Root as PDFRef).objectNumber;
      const escaped = withBody(catalog, (b) => edit(b, (t) => t.replace('/Type', '/T#79pe')));
      expect((await verify(writeClassic(escaped, trailer))).code).toBe('name_encoding');
    });

    it('refuses a dictionary that spells one key twice', async () => {
      const catalog = (doc.context.trailerInfo.Root as PDFRef).objectNumber;
      const twice = withBody(catalog, (b) => appendToDict(b, '/Type /Catalog'));
      const result = await verify(writeClassic(twice, trailer));
      expect(result.code).toBe('name_encoding');
      expect(result.reason).toContain('/Type');
    });
  });

  describe('object-stream slots (object_stream_layout)', () => {
    const inStream = (members: (ObjectBody & { offset?: number })[], without: number[]) =>
      writeWithObjectStream(objects.filter((o) => !without.includes(o.num)), { num: nextNumber() + 1, members }, trailer);

    it('refuses an extra object sharing the target\'s offset, which leaves the target an empty slot in pdf.js', async () => {
      const font = objects.find((o) => o.num === fontRef(doc).objectNumber)!;
      const bytes = inStream([font, { num: nextNumber(), body: Buffer.from('null', 'latin1'), offset: 0 }], [font.num]);
      const result = await verify(bytes);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('object_stream_layout');
    });

    it('refuses an object that runs past the next object\'s offset', async () => {
      const font = objects.find((o) => o.num === fontRef(doc).objectNumber)!;
      const bytes = inStream([font, { num: nextNumber(), body: Buffer.from('null', 'latin1'), offset: 2 }], [font.num]);
      expect((await verify(bytes)).code).toBe('object_stream_layout');
    });

    it('refuses a stream stored in an object stream', async () => {
      const font = objects.find((o) => o.num === fontRef(doc).objectNumber)!;
      const bytes = inStream([font, { num: nextNumber(), body: streamBody('<< /Length 3 >>', 'q Q') }], [font.num]);
      expect((await verify(bytes)).code).toBe('object_stream_layout');
    });
  });
});

/** The first font of the sealed page (a plain dictionary object). */
function fontRef(doc: PDFDocument): PDFRef {
  const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
  return fonts.entries()[0]![1] as PDFRef;
}
