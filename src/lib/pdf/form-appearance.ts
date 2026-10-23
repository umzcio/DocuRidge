import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, StandardFonts,
  clip, concatTransformationMatrix, drawObject, endPath, popGraphicsState,
  pushGraphicsState, rectangle,
} from 'pdf-lib';

function appearanceFor(widget: PDFDict): PDFStream | undefined {
  const ap = widget.lookupMaybe(PDFName.of('AP'), PDFDict);
  const normal = ap?.lookup(PDFName.of('N'));
  if (normal instanceof PDFStream) return normal;
  if (normal instanceof PDFDict) {
    const state = widget.lookupMaybe(PDFName.of('AS'), PDFName);
    const selected = state && normal.lookup(state);
    if (selected instanceof PDFStream) return selected;
  }
  return undefined;
}
function numbers(dict: PDFDict, key: string, fallback: number[]): number[] {
  const array = dict.lookupMaybe(PDFName.of(key), PDFArray);
  if (!array) return fallback;
  if (array.size() !== fallback.length) throw new Error(`Invalid PDF form appearance ${key}. Export a flattened PDF first.`);
  const values = array.asArray().map((value) => dict.context.lookup(value, PDFNumber).asNumber());
  if (!values.every(Number.isFinite)) throw new Error(`Invalid PDF form appearance ${key}. Export a flattened PDF first.`);
  return values;
}

/** Bake the visible widget appearances as PDF.js displays them. pdf-lib's
 * built-in flatten() neither checks visibility nor fits the transformed BBox
 * to Rect. Existing appearances are authoritative; generate only missing ones. */
export async function flattenPdfFormAppearances(doc: PDFDocument): Promise<void> {
  const form = doc.getForm();
  if (form.hasXFA()) throw new Error('This PDF uses XFA forms. Export a flattened PDF first.');
  const fields = form.getFields();
  if (!fields.length) return;
  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    const visible = widgets.filter((widget) => !(widget.getFlags() & (2 | 32)));
    if (visible.some((widget) => !appearanceFor(widget.dict))) {
      // Generators update all widgets in a field. Keep each existing AP intact,
      // including custom fonts and graphics, when repairing a different widget.
      const preserved = widgets.filter((widget) => appearanceFor(widget.dict)).map((widget) => ({
        widget, ap: widget.AP()!.clone(doc.context), state: widget.dict.get(PDFName.of('AS')),
      }));
      try {
        field.defaultUpdateAppearances(await doc.embedFont(StandardFonts.Helvetica));
      } catch {
        throw new Error('A PDF form appearance could not be generated. Export a flattened PDF first.');
      } finally {
        for (const { widget, ap, state } of preserved) {
          widget.dict.set(PDFName.of('AP'), ap);
          if (state) widget.dict.set(PDFName.of('AS'), state);
          else widget.dict.delete(PDFName.of('AS'));
        }
      }
    }
    for (const widget of widgets) {
      const page = doc.getPages().find((candidate) => {
        const annots = candidate.node.Annots();
        return annots?.asArray().some((ref) => doc.context.lookup(ref) === widget.dict);
      });
      if (!page) throw new Error('A PDF form widget has no page. Export a flattened PDF first.');
      const flags = widget.getFlags();
      if (!(flags & (2 | 32))) {
        if ((flags & 16) || widget.dict.has(PDFName.of('OC'))) {
          throw new Error('This PDF has form visibility or rotation settings that cannot be preserved. Export a flattened PDF first.');
        }
        const appearance = appearanceFor(widget.dict);
        if (!appearance) throw new Error('A PDF form appearance is missing. Export a flattened PDF first.');
        const rect = numbers(widget.dict, 'Rect', [0, 0, 0, 0]);
        const [left, right] = [Math.min(rect[0]!, rect[2]!), Math.max(rect[0]!, rect[2]!)];
        const [bottom, top] = [Math.min(rect[1]!, rect[3]!), Math.max(rect[1]!, rect[3]!)];
        if (right > left && top > bottom) {
          const bbox = numbers(appearance.dict, 'BBox', [0, 0, 1, 1]);
          const [a, b, c, d, e, f] = numbers(appearance.dict, 'Matrix', [1, 0, 0, 1, 0, 0]) as [number, number, number, number, number, number];
          const corners = [[bbox[0]!, bbox[1]!], [bbox[0]!, bbox[3]!], [bbox[2]!, bbox[1]!], [bbox[2]!, bbox[3]!]];
          const xs = corners.map(([x, y]) => a * x! + c * y! + e);
          const ys = corners.map(([x, y]) => b * x! + d * y! + f);
          const minX = Math.min(...xs), minY = Math.min(...ys);
          const width = Math.max(...xs) - minX, height = Math.max(...ys) - minY;
          const degenerate = width === 0 || height === 0;
          const sx = degenerate ? 1 : (right - left) / width;
          const sy = degenerate ? 1 : (top - bottom) / height;
          const tx = degenerate ? left : left - minX * sx;
          const ty = degenerate ? bottom : bottom - minY * sy;
          if (![sx, sy, tx, ty].every(Number.isFinite)) throw new Error('Invalid PDF form appearance transform.');
          const key = page.node.newXObject('FlatWidget', doc.context.register(appearance));
          // The Form XObject applies its own Matrix; the outer matrix fits its
          // transformed bounds to Rect, and the widget rectangle clips overflow.
          page.pushOperators(
            pushGraphicsState(), rectangle(left, bottom, right - left, top - bottom), clip(), endPath(),
            concatTransformationMatrix(sx, 0, 0, sy, tx, ty), drawObject(key), popGraphicsState(),
          );
        }
      }
      const annots = page.node.Annots()!;
      for (let i = annots.size() - 1; i >= 0; i--) {
        if (doc.context.lookup(annots.get(i)) === widget.dict) annots.remove(i);
      }
    }
  }
  form.acroForm.dict.set(PDFName.of('Fields'), doc.context.obj([]));
  doc.catalog.delete(PDFName.of('AcroForm'));
  // embedPages copies resolved resources, so materialize fonts generated above
  // before callers embed these pages into their edited/sealed output document.
  await doc.flush();
}
