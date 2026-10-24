/** Test fixtures: small PDFs whose form structure is shaped to make flattening expensive. */
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, type PDFContext } from 'pdf-lib';

/** A widget-and-field dictionary with its own appearance, so nothing needs generating. */
function widgetField(context: PDFContext, name: string, appearance?: PDFRef): PDFRef {
  const ap = appearance ?? context.register(context.stream('0 0 0 rg 0 0 10 10 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
  }));
  return context.register(context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of(name),
    Rect: [10, 10, 20, 20], AP: { N: ap },
  }));
}

async function save(doc: PDFDocument): Promise<Buffer> {
  // updateFieldAppearances would run pdf-lib's own (unbounded) form walk.
  return Buffer.from(await doc.save({ updateFieldAppearances: false, useObjectStreams: false }));
}

function setFields(doc: PDFDocument, fields: PDFRef[]): void {
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({ Fields: fields })));
}

/**
 * /Fields whose non-terminal nodes each list the same child twice: pdf-lib's
 * getFields() enumerates 2^depth paths through `depth` objects.
 */
export async function sharedKidsFormPdf(depth: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const leaf = widgetField(doc.context, 'leaf');
  page.node.set(PDFName.of('Annots'), doc.context.obj([leaf]));
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    node = doc.context.register(doc.context.obj({ T: PDFString.of(`n${i}`), Kids: [node, node] }));
  }
  setFields(doc, [node]);
  return save(doc);
}

/** A chain of `depth` nested fields, each the only kid of the one above. */
export async function deepFormPdf(depth: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const leaf = widgetField(doc.context, 'leaf');
  page.node.set(PDFName.of('Annots'), doc.context.obj([leaf]));
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    const parent = doc.context.register(doc.context.obj({ T: PDFString.of(`n${i}`), Kids: [node] }));
    doc.context.lookup(node, PDFDict).set(PDFName.of('Parent'), parent);
    node = parent;
  }
  setFields(doc, [node]);
  return save(doc);
}

/** `count` distinct widget fields on one page, all sharing one appearance stream. */
export async function wideFormPdf(count: number, sharedAppearance?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ap = doc.context.register(doc.context.stream(sharedAppearance ?? '0 0 0 rg 0 0 10 10 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
  }));
  const widgets = Array.from({ length: count }, (_, i) => widgetField(doc.context, `f${i}`, ap));
  page.node.set(PDFName.of('Annots'), doc.context.obj(widgets));
  setFields(doc, widgets);
  return save(doc);
}

/**
 * `pages` pages that all list one shared /Annots array of `annots` entries;
 * the form's single widget is in it. Flattening used to rescan that array
 * on every page for every widget.
 */
export async function sharedAnnotsPdf(pages: number, annots: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  const widget = widgetField(doc.context, 'only');
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 1, 1] }));
  const shared = doc.context.register(doc.context.obj([...Array.from({ length: annots - 1 }, () => link), widget]));
  for (const page of doc.getPages()) page.node.set(PDFName.of('Annots'), shared);
  setFields(doc, [widget]);
  return save(doc);
}

/** One text field without an appearance, so flattening must generate one. */
export async function generatedTextFormPdf(options: { text: string; multiline?: boolean; combMaxLen?: number }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const flags = (options.multiline ? 1 << 12 : 0) | (options.combMaxLen !== undefined ? 1 << 24 : 0);
  const field = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('t'), V: PDFString.of(options.text),
    DA: PDFString.of('/Helv 0 Tf 0 g'), Rect: [10, 10, 200, 200], Ff: PDFNumber.of(flags),
    ...(options.combMaxLen !== undefined ? { MaxLen: PDFNumber.of(options.combMaxLen) } : {}),
  }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([field]));
  setFields(doc, [field]);
  return save(doc);
}
