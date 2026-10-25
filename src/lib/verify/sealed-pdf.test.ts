import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  degrees,
} from 'pdf-lib';
import { SEALED_PARSE_OBJECT_HEADROOM, extractManifest, sealedMaxParseObjects, verifySealedPdf } from './sealed-pdf';
import { checkPdfStructure } from './pdf-structure';
import { PdfComplexityError } from '../pdf/seal-limits';
import { assertParseObjectCeiling } from '../pdf/object-ceiling';
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

describe('verifySealedPdf — sealed-content digest version 3', () => {
  let key: TestKey;
  let sealed: Uint8Array;

  beforeAll(async () => {
    key = await makeTestKey();
    sealed = await buildSealedPdf({ key });
  });

  it('verifies a genuine seal and reports the digest version it checked', async () => {
    const result = await verifySealedPdf(sealed);
    expect(result.ok, result.reason).toBe(true);
    expect(result.digestVersion).toBe(3);
    expect(result.legacyDigest).toBe(false);
    expect(result.checks).toContain('1 page content digest(s) verified (digest version 3)');
  });

  it('passes --strict', async () => {
    const result = await verifySealedPdf(sealed, { strict: true });
    expect(result.ok, result.reason).toBe(true);
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

function pageTreeRoot(doc: PDFDocument): { root: PDFDict; rootRef: PDFRef } {
  return {
    root: doc.catalog.lookup(PDFName.of('Pages'), PDFDict),
    rootRef: doc.catalog.get(PDFName.of('Pages')) as PDFRef,
  };
}

/** Page-tree edits that change which pages a viewer shows, or in what order. */
const PAGE_TREE_TAMPERS: [string, string, (doc: PDFDocument) => void][] = [
  ['add a page', 'sealed_content_pages', (doc) => {
    doc.addPage([612, 792]).drawText('ADDENDUM: all terms void');
  }],
  ['add a kid with no /Type and raise /Count', 'sealed_content_page_tree', (doc) => {
    const { root, rootRef } = pageTreeRoot(doc);
    const forged = doc.context.register(doc.context.obj({
      Parent: rootRef, MediaBox: [0, 0, 612, 792], Resources: {},
      Contents: doc.context.register(doc.context.flateStream('BT /F1 24 Tf 50 700 Td (ADDENDUM) Tj ET')),
    }));
    root.lookup(PDFName.of('Kids'), PDFArray).push(forged);
    root.set(PDFName.of('Count'), doc.context.obj(root.lookup(PDFName.of('Kids'), PDFArray).size()));
  }],
  ['lower the root /Count to hide the last page', 'sealed_content_page_tree', (doc) => {
    const { root } = pageTreeRoot(doc);
    root.set(PDFName.of('Count'), doc.context.obj(1));
  }],
  ['wrap the last page in a /Count 0 node', 'sealed_content_page_tree', (doc) => {
    const { root, rootRef } = pageTreeRoot(doc);
    const last = doc.getPage(1);
    const wrapper = doc.context.register(doc.context.obj({ Type: 'Pages', Kids: [last.ref], Count: 0, Parent: rootRef }));
    last.node.set(PDFName.of('Parent'), wrapper);
    root.lookup(PDFName.of('Kids'), PDFArray).set(1, wrapper);
  }],
  ['hide the last page: drop it from /Kids but keep the object', 'sealed_content_pages', (doc) => {
    const { root } = pageTreeRoot(doc);
    root.lookup(PDFName.of('Kids'), PDFArray).remove(1);
    root.set(PDFName.of('Count'), doc.context.obj(1));
  }],
  ['re-order the pages', 'sealed_content_digest', (doc) => {
    const kids = pageTreeRoot(doc).root.lookup(PDFName.of('Kids'), PDFArray);
    const [first, second] = [kids.get(0), kids.get(1)];
    kids.set(0, second);
    kids.set(1, first);
  }],
];

describe('verifySealedPdf — page tree (digest version 3)', () => {
  let key: TestKey;
  let sealed: Uint8Array;

  beforeAll(async () => {
    key = await makeTestKey();
    sealed = await buildSealedPdf({ key, auditPage: true });
  });

  it('verifies the genuine two-page seal', async () => {
    const result = await verifySealedPdf(sealed);
    expect(result.ok, result.reason).toBe(true);
    expect(result.checks).toContain('2 page content digest(s) verified (digest version 3)');
  });

  for (const [name, code, edit] of PAGE_TREE_TAMPERS) {
    it(`fails with ${code} after: ${name}`, async () => {
      const result = await verifySealedPdf(await tamper(sealed, edit));
      expect(result.ok).toBe(false);
      expect(result.code).toBe(code);
    });
  }

  it('fails with sealed_content_digest when a page is re-parented under a valid new node', async () => {
    // A well-formed tree with the same pages in the same order: harmless to
    // viewers, but v3 signs the tree shape too.
    const result = await verifySealedPdf(await tamper(sealed, (doc) => {
      const { root, rootRef } = pageTreeRoot(doc);
      const last = doc.getPage(1);
      const node = doc.context.register(doc.context.obj({ Type: 'Pages', Kids: [last.ref], Count: 1, Parent: rootRef }));
      last.node.set(PDFName.of('Parent'), node);
      root.lookup(PDFName.of('Kids'), PDFArray).set(1, node);
    }));
    expect(result.code).toBe('sealed_content_digest');
  });

  it('refuses a /Parent that points somewhere other than the listing node', async () => {
    const result = await verifySealedPdf(await tamper(sealed, (doc) => {
      const other = doc.context.register(doc.context.obj({ Type: 'Pages', Kids: [], Count: 0, Rotate: 90 }));
      doc.getPage(0).node.set(PDFName.of('Parent'), other);
    }));
    expect(result.code).toBe('sealed_content_page_tree');
  });

  it('refuses a page tree with a cycle instead of recursing forever', async () => {
    const doc = await PDFDocument.load(sealed);
    const { root, rootRef } = pageTreeRoot(doc);
    root.lookup(PDFName.of('Kids'), PDFArray).push(rootRef);
    // addDefaultPage would count pages, i.e. walk the cycle in pdf-lib.
    const result = await verifySealedPdf(await doc.save({ addDefaultPage: false }));
    expect(result.code).toBe('sealed_content_page_tree');
  });
});

describe('verifySealedPdf — seals made with digest version 2', () => {
  let key: TestKey;
  let v2: Uint8Array;

  beforeAll(async () => {
    key = await makeTestKey();
    v2 = await buildSealedPdf({ key, digestVersion: 2, auditPage: true });
  });

  it('still verify with their own algorithm, labelled version 2', async () => {
    const result = await verifySealedPdf(v2);
    expect(result.ok, result.reason).toBe(true);
    expect(result.digestVersion).toBe(2);
    expect(result.legacyDigest).toBe(true);
    expect(result.checks).toContain('2 page content digest(s) verified (digest version 2)');
  });

  it('still detect a nested-resource edit', async () => {
    const result = await verifySealedPdf(await tamper(v2, TAMPERS[0]![1]));
    expect(result.code).toBe('sealed_content_digest');
  });

  for (const [name, code, edit] of PAGE_TREE_TAMPERS) {
    it(`get the page-tree checks too: ${name}`, async () => {
      const result = await verifySealedPdf(await tamper(v2, edit));
      expect(result.ok).toBe(false);
      expect(result.code).toBe(code);
    });
  }

  it('fail under --strict, which requires version 3', async () => {
    const result = await verifySealedPdf(v2, { strict: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('sealed_content_legacy_digest');
  });
});

/** The manifest's file specification, as the seal attached it. */
function manifestFilespec(doc: PDFDocument): PDFDict {
  const names = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict)
    .lookup(PDFName.of('Names'), PDFArray);
  return names.lookup(1, PDFDict);
}

const FORGED_FILE = new TextEncoder().encode('Signed addendum: all fees waived.');

/** Ways to add a file to a sealed PDF after the seal. */
const ATTACHMENT_TAMPERS: [string, string, (doc: PDFDocument) => Promise<void>][] = [
  ['attach a second file', 'unexpected_attachment', async (doc) => {
    await doc.attach(FORGED_FILE, 'recipient-upload.pdf', { mimeType: 'application/pdf' });
  }],
  ['attach a second file named docuridge-manifest.json', 'manifest_ambiguous', async (doc) => {
    await doc.attach(FORGED_FILE, 'docuridge-manifest.json', { mimeType: 'application/json' });
  }],
  ['hide a second stream under the manifest file specification (/EF /UF)', 'unexpected_attachment', async (doc) => {
    const ef = manifestFilespec(doc).lookup(PDFName.of('EF'), PDFDict);
    ef.set(PDFName.of('UF'), doc.context.register(doc.context.flateStream(FORGED_FILE, { Type: 'EmbeddedFile' })));
  }],
  ['list another file in the catalog /AF only', 'unexpected_attachment', async (doc) => {
    const spec = doc.context.register(doc.context.obj({
      Type: 'Filespec', F: PDFString.of('terms.txt'),
      EF: { F: doc.context.register(doc.context.flateStream(FORGED_FILE, { Type: 'EmbeddedFile' })) },
    }));
    doc.catalog.lookup(PDFName.of('AF'), PDFArray).push(spec);
  }],
  ['add a file through a /Kids node of the name tree', 'unexpected_attachment', async (doc) => {
    const tree = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const spec = doc.context.register(doc.context.obj({
      Type: 'Filespec', F: PDFString.of('terms.txt'),
      EF: { F: doc.context.register(doc.context.flateStream(FORGED_FILE, { Type: 'EmbeddedFile' })) },
    }));
    tree.set(PDFName.of('Kids'), doc.context.obj([doc.context.obj({ Names: [PDFString.of('terms.txt'), spec] })]));
  }],
];

async function tamperAsync(bytes: Uint8Array, edit: (doc: PDFDocument) => Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  await edit(doc);
  return doc.save();
}

describe('verifySealedPdf — embedded files', () => {
  let key: TestKey;
  const seals: Record<number, Uint8Array> = {};

  beforeAll(async () => {
    key = await makeTestKey();
    for (const digestVersion of [1, 2, 3] as const) seals[digestVersion] = await buildSealedPdf({ key, digestVersion });
  });

  it('accepts the genuine seal, whose only attachment is the manifest', async () => {
    const result = await verifySealedPdf(seals[3]!);
    expect(result.ok, result.reason).toBe(true);
    expect(result.checks).toContain('docuridge-manifest.json is the only embedded file');
  });

  for (const [name, code, edit] of ATTACHMENT_TAMPERS) {
    for (const digestVersion of [3, 2, 1]) {
      it(`fails with ${code} after: ${name} (digest v${digestVersion})`, async () => {
        const result = await verifySealedPdf(await tamperAsync(seals[digestVersion]!, edit), {
          trust: { publicKeys: [], fingerprints: [key.fingerprint], source: '--fingerprint' },
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe(code);
      });
    }
  }

  it('fails with unexpected_attachment when the manifest file specification is renamed', async () => {
    const result = await verifySealedPdf(await tamperAsync(seals[3]!, async (doc) => {
      manifestFilespec(doc).set(PDFName.of('UF'), PDFString.of('contract-final.pdf'));
    }));
    expect(result.code).toBe('unexpected_attachment');
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

describe('verifySealedPdf — the sealed parse-object ceiling', () => {
  let sealed: Uint8Array;
  beforeAll(async () => {
    sealed = await buildSealedPdf({ key: await makeTestKey() });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is the envelope seal-object cap plus fixed headroom', () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_SEAL_OBJECTS', '7');
    expect(sealedMaxParseObjects()).toBe(7 + SEALED_PARSE_OBJECT_HEADROOM);
  });

  it('does not use the source-upload ceiling: PDF_MAX_PARSE_OBJECTS=10 still verifies a genuine seal', async () => {
    vi.stubEnv('PDF_MAX_PARSE_OBJECTS', '10');
    const result = await verifySealedPdf(sealed);
    expect(result.ok, result.reason).toBe(true);
    await expect(extractManifest(sealed)).resolves.toMatchObject({ generator: 'DocuRidge' });
  });

  it('fails with sealed_content_too_complex, not no_manifest, past a very low sealed maximum', async () => {
    const result = await verifySealedPdf(sealed, { maxParseObjects: 5 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('sealed_content_too_complex');
  });

  it('counts object-stream members in the structure check, not only what the byte scan sees', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 20; i++) doc.addPage();
    const packed = await doc.save({ useObjectStreams: true });
    // The byte scan sees only the few top-level objects; the members are many.
    expect(() => assertParseObjectCeiling(packed, 20)).not.toThrow();

    const err = await checkPdfStructure(packed, { maxParseObjects: 20 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('parse_objects');
    await expect(checkPdfStructure(packed, { maxParseObjects: 1000 })).resolves.toBeUndefined();
  });
});
