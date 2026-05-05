/**
 * Coordinate-system conversion. The DB stores fractional, top-left-origin
 * coordinates. pdf-lib uses absolute, bottom-left-origin coordinates in
 * PDF user-space points.
 *
 * This is the ONLY place that conversion happens (per D-026).
 */

export interface UiBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function uiToPdf(
  ui: UiBox,
  pageWidth: number,
  pageHeight: number,
): PdfBox {
  // Top-left fractional → bottom-left absolute.
  const x = ui.x * pageWidth;
  const w = ui.w * pageWidth;
  const h = ui.h * pageHeight;
  // y in UI is from top; flip.
  const y = pageHeight - ui.y * pageHeight - h;
  return { x, y, width: w, height: h };
}
