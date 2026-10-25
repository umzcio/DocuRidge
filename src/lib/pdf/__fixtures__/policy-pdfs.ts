/** Test fixtures: PDFs the canonical source policy refuses or accepts, built from pdf-lib low-level objects. */
import { PDFDocument, PDFName, PDFRef, type PDFDict } from 'pdf-lib';
import { pageTreeLeaves } from '../page-tree';

export interface PolicyFixture {
  doc: PDFDocument;
  leaves: PDFDict[];
}

/** Reload through save, so the fixture is what a parsed upload looks like. */
async function parsed(doc: PDFDocument): Promise<PolicyFixture> {
  const loaded = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
  return { doc: loaded, leaves: pageTreeLeaves(loaded, { mode: 'source' }) };
}

async function blank(): Promise<{ doc: PDFDocument; page: ReturnType<PDFDocument['addPage']> }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('BT /F1 12 Tf 20 100 Td (Term) Tj ET')));
  return { doc, page };
}

function annotate(doc: PDFDocument, page: { node: PDFDict }, annots: PDFRef[]): void {
  page.node.set(PDFName.of('Annots'), doc.context.obj(annots));
}

/** A text field whose /V says "12 months" and whose /AP draws "36 months", with /NeedAppearances true. */
export async function needAppearancesForm(options: { fields?: boolean } = {}): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  const fields: PDFRef[] = [];
  if (options.fields !== false) {
    const ap = doc.context.register(doc.context.stream('BT /Helv 12 Tf 2 4 Td (36 months) Tj ET', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20],
    }));
    const field = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: 'term', V: '12 months',
      Rect: [20, 20, 120, 40], F: 4, AP: { N: ap },
    }));
    fields.push(field);
    annotate(doc, page, [field]);
  }
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: fields, NeedAppearances: true }));
  return parsed(doc);
}

/** One page with the given annotation dictionaries (each registered indirectly). */
export async function annotatedPage(annots: Array<Record<string, unknown>>): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  annotate(doc, page, annots.map((a) => doc.context.register(doc.context.obj(a as never))));
  return parsed(doc);
}

/** An opaque Square annotation drawn over the page's text, with its own /AP. */
export async function opaqueSquareOverText(): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  const ap = doc.context.register(doc.context.stream('0 g 0 0 100 20 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20],
  }));
  annotate(doc, page, [doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [15, 95, 115, 115], F: 4, C: [0, 0, 0], IC: [0, 0, 0], AP: { N: ap },
  }))]);
  return parsed(doc);
}

/** A widget on the page that is not in /AcroForm /Fields. */
export async function orphanWidget(): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  annotate(doc, page, [doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: 'stray', V: 'x', Rect: [20, 20, 120, 40], F: 4,
  }))]);
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [] }));
  return parsed(doc);
}

/** A Link annotation that carries a drawn /AP /N. */
export async function linkWithAppearance(): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  const ap = doc.context.register(doc.context.stream('0 g 0 0 50 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50] }));
  annotate(doc, page, [doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], AP: { N: ap },
  }))]);
  return parsed(doc);
}

/** An /Annots entry that is a number, not a dictionary. */
export async function nonDictionaryAnnotation(): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  page.node.set(PDFName.of('Annots'), doc.context.obj([5]));
  return parsed(doc);
}

/** `count` Link annotations on one page. */
export async function manyLinks(count: number): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], Border: [0, 0, 0] }));
  annotate(doc, page, Array.from({ length: count }, () => link));
  return parsed(doc);
}

export type OptionalContentVariant = 'off' | 'base_state_off' | 'as' | 'xobject_ocmd' | 'properties_ocmd' | 'all_on' | 'none';

/** A page with a layer group and its content, configured per `variant`. */
export async function optionalContentPdf(variant: OptionalContentVariant): Promise<PolicyFixture> {
  const { doc, page } = await blank();
  if (variant === 'none') return parsed(doc);
  const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: 'Layer' }));
  // /AllOff over a group that is ON: pdf.js hides what it marks. Registered
  // only when used: the policy refuses a hidden OCMD anywhere in the file.
  const ocmd = variant === 'xobject_ocmd' || variant === 'properties_ocmd'
    ? doc.context.register(doc.context.obj({ Type: 'OCMD', OCGs: [ocg], P: 'AllOff' }))
    : ocg;
  const config: Record<string, unknown> = { Order: [ocg] };
  if (variant === 'off') config.OFF = [ocg];
  if (variant === 'base_state_off') config.BaseState = 'OFF';
  if (variant === 'as') config.AS = [{ Event: 'View', OCGs: [ocg], Category: ['View'] }];
  doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: config } as never));
  const form = doc.context.register(doc.context.stream('0 g 0 0 50 50 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50], OC: variant === 'xobject_ocmd' ? ocmd : ocg,
  }));
  const properties: Record<string, unknown> = { OC0: ocg };
  if (variant === 'properties_ocmd') properties.OC1 = ocmd;
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm0: form }, Properties: properties } as never));
  return parsed(doc);
}
