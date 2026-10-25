import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRef, PDFStream, degrees } from 'pdf-lib';

interface UprightLayout {
  box: { left: number; bottom: number; right: number; top: number };
  width: number;
  height: number;
  rotation: number;
}

/** The visible box of `source` and the unrotated size it is drawn at. */
function uprightLayout(source: PDFPage, clockwiseDelta: number): UprightLayout {
  const media = source.getMediaBox();
  const crop = source.getCropBox();
  let left = Math.max(media.x, crop.x);
  let bottom = Math.max(media.y, crop.y);
  let right = Math.min(media.x + media.width, crop.x + crop.width);
  let top = Math.min(media.y + media.height, crop.y + crop.height);
  // PDF.js falls back to MediaBox when the intersection is empty.
  if (right <= left || top <= bottom) {
    left = media.x; bottom = media.y; right = media.x + media.width; top = media.y + media.height;
  }
  const unitObject = source.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber);
  const rawUnit = unitObject?.asNumber() ?? 1;
  const unit = Number.isFinite(rawUnit) && rawUnit > 0 ? rawUnit : 1;
  const width = (right - left) * unit;
  const height = (top - bottom) * unit;
  if (![left, bottom, right, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('PDF page has invalid dimensions.');
  }
  const intrinsic = source.getRotation().angle;
  const rotation = (((intrinsic % 90 === 0 ? intrinsic : 0) + clockwiseDelta) % 360 + 360) % 360;
  return { box: { left, bottom, right, top }, width, height, rotation };
}

/** A box with four finite coordinates and a non-zero width and height. */
function isUsableBox(box: { x: number; y: number; width: number; height: number }): boolean {
  return [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width !== 0 && box.height !== 0;
}

/**
 * Throws unless `appendUprightPages` can lay `source` out: every attribute
 * it reads, resolved the way it reads them (pdf-lib, through `/Parent` for
 * the inheritable ones). `/MediaBox` must resolve to a 4-number box with a
 * non-zero width and height; `/CropBox`, when present, must read as a
 * rectangle (any area: an empty crop falls back to `/MediaBox`); `/Rotate`
 * and `/UserUnit`, when present, must have their types, as must `/Resources`
 * on a page with `/Contents` (only those pages are embedded); and the
 * visible box must have a positive size. Sources are checked with this when
 * they are loaded (decode-limits.ts), so a page that could never be sealed is
 * refused at upload and send, not after the last signature.
 */
export function assertDrawableSourcePage(source: PDFPage): void {
  if (!isUsableBox(source.getMediaBox())) throw new Error('its /MediaBox has no area');
  // /CropBox needs no area: a crop that leaves nothing visible falls back to
  // /MediaBox, in uprightLayout as in pdf.js. One pdf-lib cannot read as a
  // rectangle still throws there, below.
  // Only a page with /Contents is embedded, and only embedding reads /Resources.
  if (source.node.Contents()) source.node.Resources();
  uprightLayout(source, 0);
}

/**
 * pdf-lib writes each embedded page's (dereferenced) /Resources dictionary
 * inline in its Form XObject. Pages that share one dictionary (inherited from
 * the page tree, or one object listed by many pages) would each serialize a
 * full copy. Point every XObject that shares a dictionary at one indirect
 * copy instead; a dictionary used once stays inline, as before.
 */
function shareRepeatedResources(out: PDFDocument, xObjects: PDFRef[]): void {
  const key = PDFName.of('Resources');
  const dicts = xObjects.map((ref) => out.context.lookup(ref, PDFStream).dict);
  const uses = new Map<PDFDict, number>();
  for (const dict of dicts) {
    const resources = dict.get(key);
    if (resources instanceof PDFDict) uses.set(resources, (uses.get(resources) ?? 0) + 1);
  }
  const refs = new Map<PDFDict, PDFRef>();
  for (const dict of dicts) {
    const resources = dict.get(key);
    if (!(resources instanceof PDFDict) || (uses.get(resources) ?? 0) < 2) continue;
    let ref = refs.get(resources);
    if (!ref) {
      ref = out.context.register(resources);
      refs.set(resources, ref);
    }
    dict.set(key, ref);
  }
}

/** Draw each visible source page onto an unrotated, origin-zero page. Shared
 * by preparation and canonicalization (whose pages the seal copies and
 * stamps) so normalized signing boxes use identical axes.
 *
 * All pages are embedded in ONE embedPages call: pdf-lib memoises copied
 * objects per call, so a resource shared by many pages (a background image,
 * a font, the page tree reached through an annotation's /P) is copied into
 * `out` once, not once per page. Sources must belong to one document. */
export async function appendUprightPages(
  out: PDFDocument,
  sources: PDFPage[],
  clockwiseDeltas: number[] = [],
): Promise<PDFPage[]> {
  const layouts = sources.map((source, i) => uprightLayout(source, clockwiseDeltas[i] ?? 0));
  const pages = layouts.map(({ width, height, rotation }) => {
    const sideways = rotation === 90 || rotation === 270;
    return out.addPage(sideways ? [height, width] : [width, height]);
  });
  // Truly blank pages have no Contents and cannot be embedded by pdf-lib.
  const embeddable = sources.flatMap((source, i) => (source.node.Contents() ? [i] : []));
  if (embeddable.length === 0) return pages;
  const embedded = await out.embedPages(
    embeddable.map((i) => sources[i]!),
    embeddable.map((i) => layouts[i]!.box),
  );
  // Build the Form XObjects now rather than at the next flush, so their
  // shared /Resources can be deduplicated. This decodes each page's
  // /Contents: callers bound it with withPdfDecodeBudget as they did flush.
  for (const page of embedded) await page.embed();
  shareRepeatedResources(out, embedded.map((page) => page.ref));
  embeddable.forEach((i, k) => {
    const { width, height, rotation } = layouts[i]!;
    pages[i]!.drawPage(embedded[k]!, {
      x: rotation === 180 ? width : rotation === 270 ? height : 0,
      y: rotation === 90 ? width : rotation === 180 ? height : 0,
      width, height, rotate: degrees(-rotation),
    });
  });
  return pages;
}

/** Single-page form of appendUprightPages. Embedding pages one call at a time
 * copies their shared resources once per call; use appendUprightPages for a
 * whole document. */
export async function appendUprightPage(out: PDFDocument, source: PDFPage, clockwiseDelta = 0): Promise<PDFPage> {
  return (await appendUprightPages(out, [source], [clockwiseDelta]))[0]!;
}
