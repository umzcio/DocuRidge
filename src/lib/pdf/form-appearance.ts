import {
  PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRadioGroup, PDFRef,
  PDFStream, PDFString, PDFHexString,
  clip, concatTransformationMatrix, drawObject, endPath, popGraphicsState,
  pushGraphicsState, rectangle,
  type PDFField, type PDFObject, type PDFWidgetAnnotation,
} from 'pdf-lib';
import { PdfComplexityError, getPdfSealLimits, type PdfSealLimits } from './seal-limits';
import { annotationFlags } from './source-policy';

/** The widget's displayed normal appearance, with the reference it is stored under. */
function appearanceFor(widget: PDFDict): { stream: PDFStream; ref?: PDFRef } | undefined {
  const ap = widget.lookupMaybe(PDFName.of('AP'), PDFDict);
  const normal = ap?.lookup(PDFName.of('N'));
  if (normal instanceof PDFStream) {
    const raw = ap!.get(PDFName.of('N'));
    return { stream: normal, ref: raw instanceof PDFRef ? raw : undefined };
  }
  if (normal instanceof PDFDict) {
    const state = widget.lookupMaybe(PDFName.of('AS'), PDFName);
    const selected = state && normal.lookup(state);
    if (selected instanceof PDFStream) {
      const raw = normal.get(state!);
      return { stream: selected, ref: raw instanceof PDFRef ? raw : undefined };
    }
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

/** A /Parent that is not a dictionary ends the chain, as it does for pdf-lib. */
function parentOf(dict: PDFDict): PDFDict | undefined {
  const parent = dict.lookup(PDFName.of('Parent'));
  return parent instanceof PDFDict ? parent : undefined;
}

/**
 * Walk the /AcroForm field tree the way pdf-lib's getFields() will, before it
 * does. pdf-lib recurses into /Kids without remembering what it has visited
 * and ascends /Parent without a cycle check, so a few KB of shared /Kids make
 * it enumerate f^d fields and a /Parent loop never ends. A real field tree is
 * a tree: every field node is reached once, by one path, within the depth
 * cap. Anything else, or anything past the count caps, is refused here, so
 * the traversal that follows is linear in the file's own objects.
 */
function assertBoundedFormTree(doc: PDFDocument, limits: PdfSealLimits): void {
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(PDFName.of('Fields')) : undefined;
  if (!(fields instanceof PDFArray)) return;
  const tooManyFields = () => new PdfComplexityError(
    'form_fields', `PDF form has more than ${limits.maxFormFields} fields`,
  );
  const tooManyWidgets = () => new PdfComplexityError(
    'form_widgets', `PDF form has more than ${limits.maxFormWidgets} widgets`,
  );
  const tooDeep = () => new PdfComplexityError(
    'form_depth', `PDF form fields nest deeper than ${limits.maxFormDepth} levels`,
  );

  const seen = new Set<PDFDict>();
  const pending: Array<{ dict: PDFDict; depth: number }> = [];
  let fieldCount = 0;
  let widgetCount = 0;
  const enqueue = (kids: PDFArray, depth: number) => {
    if (depth > limits.maxFormDepth) throw tooDeep();
    for (let i = 0, n = kids.size(); i < n; i++) {
      const kid = kids.lookup(i);
      if (!(kid instanceof PDFDict)) continue;
      if (++fieldCount > limits.maxFormFields) throw tooManyFields();
      pending.push({ dict: kid, depth });
    }
  };

  enqueue(fields, 1);
  while (pending.length) {
    const { dict, depth } = pending.pop()!;
    if (seen.has(dict)) {
      throw new PdfComplexityError('form_shape', 'PDF form field tree shares or loops back to a field');
    }
    seen.add(dict);
    let ancestor = parentOf(dict);
    for (let steps = 1; ancestor; steps++) {
      if (steps > limits.maxFormDepth) throw tooDeep();
      ancestor = parentOf(ancestor);
    }
    const kids = dict.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) {
      // A field with no /Kids is its own widget.
      if (++widgetCount > limits.maxFormWidgets) throw tooManyWidgets();
      continue;
    }
    if (kids.size() > limits.maxFormFields + limits.maxFormWidgets) throw tooManyFields();
    // pdf-lib's rule: a node whose kids include a titled dictionary is a
    // non-terminal field, and all its kids are fields; otherwise its kids are
    // its widgets.
    let nonTerminal = false;
    for (let i = 0, n = kids.size(); i < n && !nonTerminal; i++) {
      const kid = kids.lookup(i);
      nonTerminal = kid instanceof PDFDict && kid.has(PDFName.of('T'));
    }
    if (nonTerminal) {
      enqueue(kids, depth + 1);
    } else {
      widgetCount += kids.size();
      if (widgetCount > limits.maxFormWidgets) throw tooManyWidgets();
    }
  }
}

/**
 * Map each annotation dictionary to the first page listing it, scanning every
 * page's /Annots once (not once per widget). The scan is capped, counting a
 * shared /Annots array again for each page that lists it.
 */
function indexAnnotationPages(doc: PDFDocument, pages: PDFPage[], limits: PdfSealLimits): Map<PDFDict, PDFPage> {
  const index = new Map<PDFDict, PDFPage>();
  let scanned = 0;
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    scanned += annots.size();
    if (scanned > limits.maxAnnotations) {
      throw new PdfComplexityError('annotations', `PDF pages list more than ${limits.maxAnnotations} annotations`);
    }
    for (let i = 0, n = annots.size(); i < n; i++) {
      const annot = doc.context.lookup(annots.get(i));
      if (annot instanceof PDFDict && !index.has(annot)) index.set(annot, page);
    }
  }
  return index;
}

/** A form value as pdf.js decodes it (`_decodeFormValue`). */
function formValue(value: PDFObject | undefined): string | string[] | null {
  if (value instanceof PDFName) return value.decodeText();
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFArray) {
    return value.asArray().flatMap((item) => (item instanceof PDFString || item instanceof PDFHexString ? [item.decodeText()] : []));
  }
  return null;
}

/** An attribute of a widget or one of its ancestor fields, nearest first. */
function inherited(widget: PDFDict, key: string): PDFObject | undefined {
  let node: PDFDict | undefined = widget;
  for (let steps = 0; node && steps <= 64; steps++, node = parentOf(node)) {
    const value = node.lookup(PDFName.of(key));
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Whether pdf.js 4.10 draws anything for a check box or radio button widget
 * whose /AS does not select a normal appearance (ButtonWidgetAnnotation's
 * `_processCheckBox`, `_processRadioButton` and `getOperatorList`). It then
 * picks the "on" or "Off" appearance from the field's value, and makes up a
 * check mark or a disc when the "on" one is missing. The canonical file
 * cannot reproduce that choice faithfully, so such a widget is refused
 * rather than dropped.
 */
function buttonDrawsWithoutState(field: PDFField, widget: PDFDict): boolean {
  const checkBox = field instanceof PDFCheckBox;
  if (!checkBox && !(field instanceof PDFRadioGroup)) return false;
  const ap = widget.lookup(PDFName.of('AP'));
  const normal = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : undefined;
  if (!(normal instanceof PDFDict) || normal instanceof PDFStream) return false;
  const keys = normal.keys().map((key) => key.decodeText());
  const appearance = (key: unknown) => typeof key === 'string' && normal.lookup(PDFName.of(key)) instanceof PDFStream;
  let fieldValue = formValue(inherited(widget, 'V'));
  let onValue: unknown;
  if (checkBox) {
    const state = formValue(widget.lookup(PDFName.of('AS')));
    if (typeof state === 'string') fieldValue = state;
    const yes = fieldValue !== null && fieldValue !== 'Off' ? fieldValue : 'Yes';
    let exportValues: unknown[] = [...keys];
    if (exportValues.length === 0) exportValues = ['Off', yes];
    else if (exportValues.length === 1) exportValues = exportValues[0] === 'Off' ? ['Off', yes] : ['Off', exportValues[0]];
    else if (exportValues.includes(yes)) exportValues = ['Off', yes];
    else exportValues = ['Off', exportValues.find((value) => value !== 'Off')];
    if (!exportValues.includes(fieldValue)) fieldValue = 'Off';
    onValue = exportValues[1];
  } else {
    const parent = parentOf(widget);
    const parentValue = parent?.lookup(PDFName.of('V'));
    if (parentValue instanceof PDFName) fieldValue = parentValue.decodeText();
    onValue = keys.find((key) => key !== 'Off') ?? null;
  }
  // "On": its appearance, or one pdf.js generates. "Off": its appearance or nothing.
  return fieldValue === onValue ? true : appearance('Off');
}

/**
 * Bake the visible widget appearances into the page content as pdf.js 4.10
 * draws them on a canvas (no annotation layer, no /NeedAppearances, which
 * canonicalization refuses). pdf-lib's built-in flatten() neither checks
 * visibility nor fits the transformed BBox to Rect.
 *
 * A widget is drawn only through its own normal appearance (/AP /N, or the
 * /N state its /AS selects). One without, pdf.js draws nothing for, so it is
 * dropped, not given a generated appearance; the exception is a check box or
 * radio button pdf.js would still draw from its value, which is refused (see
 * `buttonDrawsWithoutState`). Flags are read as pdf.js reads them
 * (`annotationFlags`).
 *
 * Every step is bounded by the caps in seal-limits.ts (field and widget
 * counts, tree depth and shape, annotations scanned); over a cap it throws
 * PdfComplexityError before doing that work.
 */
export async function flattenPdfFormAppearances(
  doc: PDFDocument,
  limits: PdfSealLimits = getPdfSealLimits(),
): Promise<void> {
  assertBoundedFormTree(doc, limits);
  const form = doc.getForm();
  if (form.hasXFA()) throw new Error('This PDF uses XFA forms. Export a flattened PDF first.');
  const fields = form.getFields();
  if (!fields.length) return;
  const pages = doc.getPages();
  const annotationPages = indexAnnotationPages(doc, pages, limits);
  const flattened = new Set<PDFDict>();
  // A Form XObject is drawn through its existing reference, or registered
  // once, so an appearance shared by many widgets is still written once.
  const appearanceRefs = new Map<PDFStream, PDFRef>();
  for (const field of fields) {
    const widgets: PDFWidgetAnnotation[] = field.acroField.getWidgets();
    for (const widget of widgets) {
      // A widget already flattened through another field has left its page.
      const page = flattened.has(widget.dict) ? undefined : annotationPages.get(widget.dict);
      if (!page) throw new Error('A PDF form widget has no page. Export a flattened PDF first.');
      const flags = annotationFlags(widget.dict);
      if (!(flags & (2 | 32))) {
        if ((flags & 16) || widget.dict.has(PDFName.of('OC'))) {
          throw new Error('This PDF has form visibility or rotation settings that cannot be preserved. Export a flattened PDF first.');
        }
        const appearance = appearanceFor(widget.dict);
        if (!appearance && buttonDrawsWithoutState(field, widget.dict)) {
          throw new Error('A PDF check box or radio button has no appearance for its state. Export a flattened PDF first.');
        }
        const rect = appearance ? numbers(widget.dict, 'Rect', [0, 0, 0, 0]) : [0, 0, 0, 0];
        const [left, right] = [Math.min(rect[0]!, rect[2]!), Math.max(rect[0]!, rect[2]!)];
        const [bottom, top] = [Math.min(rect[1]!, rect[3]!), Math.max(rect[1]!, rect[3]!)];
        if (appearance && right > left && top > bottom) {
          const bbox = numbers(appearance.stream.dict, 'BBox', [0, 0, 1, 1]);
          const [a, b, c, d, e, f] = numbers(appearance.stream.dict, 'Matrix', [1, 0, 0, 1, 0, 0]) as [number, number, number, number, number, number];
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
          let ref = appearance.ref ?? appearanceRefs.get(appearance.stream);
          if (!ref) {
            ref = doc.context.register(appearance.stream);
            appearanceRefs.set(appearance.stream, ref);
          }
          const key = page.node.newXObject('FlatWidget', ref);
          // The Form XObject applies its own Matrix; the outer matrix fits its
          // transformed bounds to Rect, and the widget rectangle clips overflow.
          page.pushOperators(
            pushGraphicsState(), rectangle(left, bottom, right - left, top - bottom), clip(), endPath(),
            concatTransformationMatrix(sx, 0, 0, sy, tx, ty), drawObject(key), popGraphicsState(),
          );
        }
      }
      flattened.add(widget.dict);
    }
  }
  // Drop the flattened widgets from every page in one pass per /Annots array.
  const swept = new Set<PDFArray>();
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots || swept.has(annots)) continue;
    swept.add(annots);
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = doc.context.lookup(annots.get(i));
      if (annot instanceof PDFDict && flattened.has(annot)) annots.remove(i);
    }
  }
  form.acroForm.dict.set(PDFName.of('Fields'), doc.context.obj([]));
  doc.catalog.delete(PDFName.of('AcroForm'));
  await doc.flush();
}
