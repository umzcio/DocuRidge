import { describe, it, expect, beforeAll } from 'vitest';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  degrees,
} from 'pdf-lib';
import { verifySealedPdf } from './sealed-pdf';
import { sealedContentDigestFromBytes } from '../pdf/content-digest';
import { buildSealedPdf, makeTestKey, type TestKey } from './__fixtures__/sealed-pdf';

/** The source page, embedded by the sealer as a Form XObject on the sealed page. */
function embeddedForm(doc: PDFDocument): { form: PDFStream; formRes: PDFDict } {
  const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects.entries()) {
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFStream && stream.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
      return { form: stream, formRes: stream.dict.lookup(PDFName.of('Resources'), PDFDict) };
    }
  }
  throw new Error('sealed fixture has no embedded page form');
}

function firstEntry(dict: PDFDict, key: string): PDFRef {
  const sub = dict.lookup(PDFName.of(key), PDFDict);
  const [, ref] = sub.entries()[0]!;
  return ref as PDFRef;
}

async function tamper(bytes: Uint8Array, edit: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  edit(doc);
  return doc.save();
}

/** Edits the v1 digest did not cover; each changes what a reader sees. */
const TAMPERS: [string, (doc: PDFDocument) => void][] = [
  ['replace the nested source-page image', (doc) => {
    const { formRes } = embeddedForm(doc);
    const imageRef = firstEntry(formRes, 'XObject');
    const original = doc.context.lookup(imageRef, PDFStream);
    const replacement = doc.context.flateStream(new Uint8Array(4 * 4 * 3).fill(0xff), {
      Type: 'XObject', Subtype: 'Image', Width: 4, Height: 4, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    });
    expect(original.dict.get(PDFName.of('Subtype'))).toBe(PDFName.of('Image'));
    doc.context.assign(imageRef, replacement);
  }],
  ['add a FreeText annotation', (doc) => {
    const annot = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'FreeText', Rect: [50, 650, 300, 680],
      Contents: PDFString.of('AMOUNT: $1,000,000'), DA: PDFString.of('/Helv 14 Tf 0 g'),
    }));
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annot]));
  }],
  ["change a nested font's /Encoding", (doc) => {
    const { formRes } = embeddedForm(doc);
    const font = doc.context.lookup(firstEntry(formRes, 'Font'), PDFDict);
    font.set(PDFName.of('Encoding'), doc.context.obj({
      Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [49, PDFName.of('nine')],
    }));
  }],
  ['change /CropBox', (doc) => {
    doc.getPage(0).node.set(PDFName.of('CropBox'), doc.context.obj([0, 300, 612, 792]));
  }],
  ["change the embedded page Form XObject's /Matrix", (doc) => {
    embeddedForm(doc).form.dict.set(PDFName.of('Matrix'), doc.context.obj([1, 0, 0, 1, 0, -100]));
  }],
  ['set /Rotate inherited from the page tree', (doc) => {
    doc.catalog.lookup(PDFName.of('Pages'), PDFDict).set(PDFName.of('Rotate'), doc.context.obj(90));
  }],
  ['set /Rotate on the page', (doc) => {
    doc.getPage(0).setRotation(degrees(180));
  }],
  ['hide content via catalog optional-content defaults', (doc) => {
    const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Body') }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
  }],
];

describe('verifySealedPdf — sealed-content digest version 2', () => {
  let key: TestKey;
  let sealed: Uint8Array;

  beforeAll(async () => {
    key = await makeTestKey();
    sealed = await buildSealedPdf({ key });
  });

  it('verifies a genuine seal and reports the digest version it checked', async () => {
    const result = await verifySealedPdf(sealed);
    expect(result.ok, result.reason).toBe(true);
    expect(result.digestVersion).toBe(2);
    expect(result.legacyDigest).toBe(false);
    expect(result.checks).toContain('1 page content digest(s) verified (digest version 2)');
  });

  it('still verifies after a no-op load/save round trip', async () => {
    const result = await verifySealedPdf(await tamper(sealed, () => {}));
    expect(result.ok, result.reason).toBe(true);
  });

  for (const [name, edit] of TAMPERS) {
    it(`fails with sealed_content_digest after tampering: ${name}`, async () => {
      const result = await verifySealedPdf(await tamper(sealed, edit));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('sealed_content_digest');
    });
  }

  it('the legacy v1 digest misses these edits (why the version exists)', async () => {
    const before = await sealedContentDigestFromBytes(sealed, 1);
    const missedByV1: string[] = [];
    for (const [name, edit] of TAMPERS) {
      const after = await sealedContentDigestFromBytes(await tamper(sealed, edit), 1);
      if (after.pageDigests[0] === before.pageDigests[0]) missedByV1.push(name);
    }
    expect(missedByV1).toEqual(TAMPERS.map(([name]) => name));
  });

  it('rejects a manifest declaring an unknown digest version', async () => {
    const future = await buildSealedPdf({ key, declaredDigestVersion: 99 });
    const result = await verifySealedPdf(future);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('sealed_content_version');
  });
});

describe('verifySealedPdf — seals made with the legacy v1 digest', () => {
  let key: TestKey;
  let legacy: Uint8Array;

  beforeAll(async () => {
    key = await makeTestKey();
    legacy = await buildSealedPdf({ key, digestVersion: 1 });
  });

  it('still verify, flagged as legacy digest version 1', async () => {
    const result = await verifySealedPdf(legacy);
    expect(result.ok, result.reason).toBe(true);
    expect(result.digestVersion).toBe(1);
    expect(result.legacyDigest).toBe(true);
  });

  it('still detect a page content stream edit', async () => {
    const edited = await tamper(legacy, (doc) => {
      doc.getPage(0).drawRectangle({ x: 0, y: 0, width: 10, height: 10 });
    });
    const result = await verifySealedPdf(edited);
    expect(result.code).toBe('sealed_content_digest');
  });

  it('fail under --strict', async () => {
    const result = await verifySealedPdf(legacy, { strict: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('sealed_content_legacy_digest');
  });
});

describe('verifySealedPdf — other failures', () => {
  it('reports no_manifest for a PDF without one', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const result = await verifySealedPdf(await doc.save());
    expect(result.code).toBe('no_manifest');
  });

  it('keeps page-tree back-references out of the digest walk', async () => {
    // An annotation's /P points back at its page and a link /Dest at another
    // page; the walk must record those, not follow them into the whole tree.
    const key = await makeTestKey();
    const sealed = await buildSealedPdf({ key });
    const linked = await tamper(sealed, (doc) => {
      const page = doc.getPage(0);
      const other = doc.addPage();
      const link = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], P: page.ref, Dest: [other.ref, PDFName.of('Fit')],
      }));
      page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
    });
    const a = await sealedContentDigestFromBytes(linked);
    const b = await sealedContentDigestFromBytes(await tamper(linked, (doc) => {
      doc.getPage(1).drawRectangle({ x: 0, y: 0, width: 5, height: 5 });
    }));
    expect(a.pageDigests[0]).toBe(b.pageDigests[0]);
    expect(a.pageDigests[1]).not.toBe(b.pageDigests[1]);
  });
});
