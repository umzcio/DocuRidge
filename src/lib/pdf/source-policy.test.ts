import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFName } from 'pdf-lib';
import { PdfComplexityError, getPdfSealLimits } from './seal-limits';
import { reviveError } from '../pdf-worker/errors';
import { serializeError } from '../pdf-worker/protocol';
import {
  SourcePolicyError, assertNoNeedAppearances, assertNoVisibleAnnotations, optionalContentPolicy,
  type SourcePolicyReason,
} from './source-policy';
import {
  annotatedPage, linkWithAppearance, manyLinks, nonDictionaryAnnotation, needAppearancesForm, opaqueSquareOverText, optionalContentPdf, orphanWidget,
} from './__fixtures__/policy-pdfs';

function reasonOf(fn: () => unknown): SourcePolicyReason | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof SourcePolicyError) return err.reason;
    throw err;
  }
  return undefined;
}

describe('assertNoNeedAppearances', () => {
  it('refuses /NeedAppearances true on a form whose /V and /AP differ', async () => {
    const { doc } = await needAppearancesForm();
    expect(reasonOf(() => assertNoNeedAppearances(doc))).toBe('need_appearances');
  });

  it('accepts /NeedAppearances true on a document with no fields', async () => {
    const { doc } = await needAppearancesForm({ fields: false });
    expect(() => assertNoNeedAppearances(doc)).not.toThrow();
  });
});

describe('assertNoVisibleAnnotations', () => {
  const check = ({ doc, leaves }: { doc: Parameters<typeof assertNoVisibleAnnotations>[0]; leaves: Parameters<typeof assertNoVisibleAnnotations>[1] }) =>
    reasonOf(() => assertNoVisibleAnnotations(doc, leaves));

  it('refuses an opaque Square annotation over text', async () => {
    expect(check(await opaqueSquareOverText())).toBe('visible_annotations');
  });

  it('refuses a Square annotation with no /AP', async () => {
    expect(check(await annotatedPage([{ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 50, 50], C: [1, 0, 0] }]))).toBe('visible_annotations');
  });

  it('refuses an orphan widget outside the field tree', async () => {
    expect(check(await orphanWidget())).toBe('visible_annotations');
  });

  it('accepts Link and Popup annotations without appearances, and a Hidden FreeText', async () => {
    const fixture = await annotatedPage([
      { Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] },
      { Type: 'Annot', Subtype: 'Popup', Rect: [0, 0, 10, 10] },
      { Type: 'Annot', Subtype: 'FreeText', Rect: [0, 0, 10, 10], F: 2, Contents: 'x' },
      { Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 10, 10], F: 32 },
    ]);
    expect(check(fixture)).toBeUndefined();
  });

  it('refuses a Link with a visible /AP /N', async () => {
    expect(check(await linkWithAppearance())).toBe('visible_annotations');
  });

  it('refuses an annotation entry that is not a dictionary', async () => {
    expect(check(await nonDictionaryAnnotation())).toBe('visible_annotations');
  });

  it('caps the annotation scan', async () => {
    const limit = getPdfSealLimits().maxAnnotations;
    const { doc, leaves } = await manyLinks(limit + 1);
    let caught: unknown;
    try {
      assertNoVisibleAnnotations(doc, leaves);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfComplexityError);
    expect((caught as PdfComplexityError).limit).toBe('annotations');
  });
});

describe('optionalContentPolicy', () => {
  it.each([
    ['an OFF group in /D /OFF', 'off'],
    ['/BaseState /OFF', 'base_state_off'],
    ['a /D /AS array', 'as'],
    ['an /AllOff OCMD used as /OC on an XObject', 'xobject_ocmd'],
    ['an /AllOff OCMD in /Resources /Properties', 'properties_ocmd'],
  ] as const)('refuses %s', async (_name, variant) => {
    const { doc } = await optionalContentPdf(variant);
    expect(reasonOf(() => optionalContentPolicy(doc))).toBe('hidden_layers');
  });

  it('accepts groups that are all ON', async () => {
    const { doc } = await optionalContentPdf('all_on');
    expect(optionalContentPolicy(doc)).toBe('all_on');
  });

  it('returns none without /OCProperties', async () => {
    const { doc } = await optionalContentPdf('none');
    expect(optionalContentPolicy(doc)).toBe('none');
  });
});

describe('SourcePolicyError across the worker boundary', () => {
  it('revives with its reason as code', () => {
    const revived = reviveError(serializeError(new SourcePolicyError('hidden_layers')));
    expect(revived).toBeInstanceOf(SourcePolicyError);
    expect((revived as SourcePolicyError).reason).toBe('hidden_layers');
  });

  it('does not revive an unknown reason as a SourcePolicyError', () => {
    const revived = reviveError({ name: 'SourcePolicyError', message: 'x', code: 'nope' });
    expect(revived).not.toBeInstanceOf(SourcePolicyError);
  });
});

describe('optionalContentPolicy scans the whole file', () => {
  it('refuses a hidden OCMD that no page reaches directly (any object may be drawn through another)', async () => {
    const { doc } = await optionalContentPdf('all_on');
    const [ocg] = (doc.catalog.lookup(PDFName.of('OCProperties'), PDFDict).lookup(PDFName.of('OCGs'), PDFArray)).asArray();
    doc.context.register(doc.context.obj({ Type: 'OCMD', OCGs: [ocg!], P: 'AnyOff' }));
    expect(reasonOf(() => optionalContentPolicy(doc))).toBe('hidden_layers');
  });

  it('caps the scan by PDF_MAX_SEAL_OBJECTS', async () => {
    const { doc } = await optionalContentPdf('all_on');
    vi.stubEnv('PDF_MAX_SEAL_OBJECTS', '3');
    try {
      expect(() => optionalContentPolicy(doc)).toThrow(PdfComplexityError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
