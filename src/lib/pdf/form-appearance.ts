import {
  PDFArray, PDFButton, PDFContentStream, PDFDict, PDFDocument, PDFDropdown, PDFFont, PDFName,
  PDFNumber, PDFOptionList, PDFPage, PDFRef, PDFStream, PDFTextField, StandardFonts,
  clip, concatTransformationMatrix, drawObject, endPath, popGraphicsState,
  pushGraphicsState, rectangle,
  type PDFField, type PDFWidgetAnnotation,
} from 'pdf-lib';
import { PdfComplexityError, getPdfSealLimits, type PdfSealLimits } from './seal-limits';

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

/**
 * Characters pdf-lib lays out to generate this field's widget appearances.
 * Its layout cost follows these (multiline layout roughly cubically), so they
 * are bounded before generation runs.
 */
function generatedTextChars(field: PDFField, widgets: PDFWidgetAnnotation[], limits: PdfSealLimits): number {
  let perWidget = 1;
  if (field instanceof PDFTextField) {
    const text = field.getText() ?? '';
    if (field.isMultiline() && text.length > limits.maxFormMultilineChars) {
      throw new PdfComplexityError(
        'form_text', `PDF form has a multiline field whose text exceeds ${limits.maxFormMultilineChars} characters without an appearance`,
      );
    }
    perWidget += text.length;
    // A comb field lays out one cell per /MaxLen, whatever the text length.
    if (field.isCombed()) perWidget += field.getMaxLength() ?? 0;
  } else if (field instanceof PDFOptionList) {
    for (const option of field.getOptions()) perWidget += option.length + 1;
  } else if (field instanceof PDFDropdown) {
    for (const selected of field.getSelected()) perWidget += selected.length + 1;
  } else if (field instanceof PDFButton) {
    for (const widget of widgets) {
      const captions = widget.getAppearanceCharacteristics()?.getCaptions();
      perWidget += (captions?.normal?.length ?? 0) + (captions?.down?.length ?? 0);
    }
  }
  return perWidget * widgets.length;
}

/** Bytes of appearance content pdf-lib generated (parsed appearances are PDFRawStream). */
function generatedAppearanceBytes(doc: PDFDocument, widgets: PDFWidgetAnnotation[]): number {
  let bytes = 0;
  const count = (value: unknown) => {
    const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (resolved instanceof PDFContentStream) bytes += resolved.getContentsSize();
    else if (resolved instanceof PDFDict) {
      for (const [, state] of resolved.entries()) {
        const stream = state instanceof PDFRef ? doc.context.lookup(state) : state;
        if (stream instanceof PDFContentStream) bytes += stream.getContentsSize();
      }
    }
  };
  for (const widget of widgets) {
    const ap = widget.dict.lookup(PDFName.of('AP'));
    if (ap instanceof PDFDict) for (const [, value] of ap.entries()) count(value);
  }
  return bytes;
}

/** Bake the visible widget appearances as PDF.js displays them. pdf-lib's
 * built-in flatten() neither checks visibility nor fits the transformed BBox
 * to Rect. Existing appearances are authoritative; generate only missing ones.
 *
 * Every step is bounded by the caps in seal-limits.ts (field and widget
 * counts, tree depth and shape, annotations scanned, generated text and
 * bytes); over a cap it throws PdfComplexityError before doing that work. */
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
  let font: PDFFont | undefined;
  let textChars = 0;
  let generatedBytes = 0;
  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    const visible = widgets.filter((widget) => !(widget.getFlags() & (2 | 32)));
    if (visible.some((widget) => !appearanceFor(widget.dict))) {
      textChars += generatedTextChars(field, widgets, limits);
      if (textChars > limits.maxFormTextChars) {
        throw new PdfComplexityError(
          'form_text', `PDF form needs more than ${limits.maxFormTextChars} characters of generated appearance text`,
        );
      }
      // Generators update all widgets in a field. Keep each existing AP intact,
      // including custom fonts and graphics, when repairing a different widget.
      const preserved = widgets.filter((widget) => appearanceFor(widget.dict)).map((widget) => ({
        widget, ap: widget.AP()!.clone(doc.context), state: widget.dict.get(PDFName.of('AS')),
      }));
      try {
        font ??= await doc.embedFont(StandardFonts.Helvetica);
        field.defaultUpdateAppearances(font);
      } catch {
        throw new Error('A PDF form appearance could not be generated. Export a flattened PDF first.');
      } finally {
        for (const { widget, ap, state } of preserved) {
          widget.dict.set(PDFName.of('AP'), ap);
          if (state) widget.dict.set(PDFName.of('AS'), state);
          else widget.dict.delete(PDFName.of('AS'));
        }
      }
      generatedBytes += generatedAppearanceBytes(doc, widgets);
      if (generatedBytes > limits.maxFormGeneratedBytes) {
        throw new PdfComplexityError(
          'form_generated_bytes', `PDF form appearances generate more than ${limits.maxFormGeneratedBytes} bytes`,
        );
      }
    }
    for (const widget of widgets) {
      // A widget already flattened through another field has left its page.
      const page = flattened.has(widget.dict) ? undefined : annotationPages.get(widget.dict);
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
  // embedPages copies resolved resources, so materialize fonts generated above
  // before callers embed these pages into their edited/canonical output document.
  await doc.flush();
}
