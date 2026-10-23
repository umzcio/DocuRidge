export interface PdfPageEdit {
  /** One-based page in the input file. */
  sourcePage: number;
  /** Clockwise delta from the input file's displayed orientation. */
  rotation: number;
}
export interface PdfAnnotation {
  /** One-based output page; geometry is normalized from its top-left. */
  page: number;
  kind: 'text' | 'highlight';
  x: number; y: number; w: number; h: number;
  text?: string;
}

type FieldBox = { page: number; x: number; y: number; w: number; h: number };

export function validatePages(pages: PdfPageEdit[], count = Infinity) {
  if (!pages.length) throw new Error('Keep at least one PDF page.');
  const seen = new Set<number>();
  for (const page of pages) {
    if (!Number.isInteger(page.sourcePage) || page.sourcePage < 1 || page.sourcePage > count || seen.has(page.sourcePage)) {
      throw new Error('PDF page selection is invalid or contains duplicate pages.');
    }
    if (!Number.isFinite(page.rotation) || page.rotation % 90 !== 0) throw new Error('Page rotation must be a multiple of 90 degrees.');
    seen.add(page.sourcePage);
  }
}
export function validateBox(box: FieldBox, count = Infinity) {
  if (!Number.isInteger(box.page) || box.page < 1 || box.page > count ||
      ![box.x, box.y, box.w, box.h].every(Number.isFinite) ||
      box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 ||
      box.x + box.w > 1 + 1e-9 || box.y + box.h > 1 + 1e-9) {
    throw new Error('Field or annotation must fit within a valid PDF page.');
  }
}

export function remapFieldsForPages<T extends FieldBox>(fields: T[], pages: PdfPageEdit[]): T[] {
  validatePages(pages);
  const destinations = new Map(pages.map((page, index) => [page.sourcePage, { ...page, page: index + 1 }]));
  return fields.flatMap((field) => {
    validateBox(field);
    const destination = destinations.get(field.page);
    if (!destination) return [];
    let { x, y, w, h } = field;
    const turns = ((destination.rotation % 360 + 360) % 360) / 90;
    for (let i = 0; i < turns; i++) [x, y, w, h] = [Math.max(0, 1 - y - h), x, h, w];
    return [{ ...field, page: destination.page, x, y, w, h }];
  });
}

