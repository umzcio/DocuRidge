import { PDFDocument, PDFName, PDFNumber, PDFPage, degrees } from 'pdf-lib';

/** Draw the visible source page onto an unrotated, origin-zero page. Shared
 * by preparation and sealing so normalized signing boxes use identical axes. */
export async function appendUprightPage(out: PDFDocument, source: PDFPage, clockwiseDelta = 0): Promise<PDFPage> {
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
  const sideways = rotation === 90 || rotation === 270;
  const page = out.addPage(sideways ? [height, width] : [width, height]);
  // Truly blank pages have no Contents and cannot be embedded by pdf-lib.
  if (source.node.Contents()) {
    const embedded = await out.embedPage(source, { left, bottom, right, top });
    page.drawPage(embedded, {
      x: rotation === 180 ? width : rotation === 270 ? height : 0,
      y: rotation === 90 ? width : rotation === 180 ? height : 0,
      width, height, rotate: degrees(-rotation),
    });
  }
  return page;
}
