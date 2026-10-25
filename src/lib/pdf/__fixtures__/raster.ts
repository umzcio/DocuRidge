/**
 * Test helper: render a PDF page with pdf.js (the legacy build, the canvas
 * path signers and senders see, no annotation layer) and measure its ink.
 * Render-comparison tests compare the inked fraction of a region between an
 * original upload and its canonical copy.
 */
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PageRaster {
  width: number;
  height: number;
  /** One entry per pixel, row-major from the top-left: true when dark. */
  dark: boolean[];
}

/** Page `pageNumber` (1-based) rendered at scale 1. */
export async function rasterPage(bytes: Uint8Array, pageNumber = 1): Promise<PageRaster> {
  const doc = await getDocument({
    data: bytes.slice(), useSystemFonts: false,
    standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
  }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const dark: boolean[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
      dark.push(pixels[i]! < 100 && pixels[i + 1]! < 100 && pixels[i + 2]! < 100);
    }
    return { width: canvas.width, height: canvas.height, dark };
  } finally {
    await doc.destroy();
  }
}

/**
 * The fraction of dark pixels in a region given in the rendered page's own
 * pixels (origin top-left), or in the whole page.
 */
export function inkFraction(
  raster: PageRaster,
  region: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: raster.width, height: raster.height },
): number {
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const x1 = Math.min(raster.width, Math.round(region.x + region.width));
  const y1 = Math.min(raster.height, Math.round(region.y + region.height));
  if (x1 <= x0 || y1 <= y0) return 0;
  let dark = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (raster.dark[y * raster.width + x]) dark++;
  return dark / ((x1 - x0) * (y1 - y0));
}

/** Shorthand: ink fraction of page 1 in a region (page pixels, origin top-left). */
export async function pageInk(
  bytes: Uint8Array,
  region?: { x: number; y: number; width: number; height: number },
): Promise<number> {
  return inkFraction(await rasterPage(bytes), region);
}
