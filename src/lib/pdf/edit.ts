import { PDFDict, PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { uiToPdf } from './coords';
import { appendUprightPages } from './upright-page';
import { flattenPdfFormAppearances } from './form-appearance';

import { validatePages, validateBox, type PdfPageEdit, type PdfAnnotation } from './page-edits';

export { remapFieldsForPages } from './page-edits';
export type { PdfPageEdit, PdfAnnotation } from './page-edits';

export async function applyPdfEdits(bytes: Uint8Array, pages: PdfPageEdit[], annotations: PdfAnnotation[] = []): Promise<Uint8Array> {
  validatePages(pages);
  const source = await PDFDocument.load(bytes);
  validatePages(pages, source.getPageCount());
  const form = source.getForm();
  if (form.hasXFA()) throw new Error('This PDF uses XFA forms. Export a flattened PDF before editing.');
  const formWidgets = new Set(form.getFields().flatMap((field) => field.acroField.getWidgets().map((widget) => widget.dict)));
  // Embedding pages discards annotation dictionaries. Reject unsupported
  // annotations explicitly instead of losing comments, links or ink silently.
  for (const edit of pages) {
    const annots = source.getPage(edit.sourcePage - 1).node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i, PDFDict);
      if (annot.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Widget' || !formWidgets.has(annot)) {
        throw new Error('This PDF contains existing annotations that cannot be preserved. Export a flattened PDF before editing.');
      }
    }
  }
  await flattenPdfFormAppearances(source);

  const out = await PDFDocument.create();
  await appendUprightPages(out, pages.map((edit) => source.getPage(edit.sourcePage - 1)), pages.map((edit) => edit.rotation));
  const font = annotations.some((a) => a.kind === 'text') ? await out.embedFont(StandardFonts.Helvetica) : undefined;
  for (const annotation of annotations) {
    validateBox(annotation, pages.length);
    const page = out.getPage(annotation.page - 1);
    const box = uiToPdf(annotation, page.getWidth(), page.getHeight());
    if (annotation.kind === 'highlight') {
      page.drawRectangle({ ...box, color: rgb(1, .85, 0), opacity: .3 });
    } else if (annotation.kind === 'text') {
      if (!annotation.text?.trim() || annotation.text.length > 5000) throw new Error('Enter annotation text (up to 5,000 characters).');
      const lines = annotation.text.replace(/\r\n?/g, '\n').split('\n');
      let widths: number[];
      try { widths = lines.map((line) => font!.widthOfTextAtSize(line, 1)); }
      catch { throw new Error('Annotation text contains unsupported characters. Use Latin text supported by the PDF font.'); }
      const size = Math.min(14, box.height / (lines.length * 1.2), box.width / Math.max(1, ...widths));
      lines.forEach((line, i) => page.drawText(line, {
        x: box.x, y: box.y + box.height - size * (1 + i * 1.2), size, font: font!, color: rgb(0, 0, 0),
      }));
    } else {
      throw new Error('Unsupported PDF annotation type.');
    }
  }
  return out.save();
}
