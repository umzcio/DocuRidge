/**
 * Validate a recipient-supplied signature/initials image before it is ever
 * persisted or embedded into a sealed PDF. Previously the schema accepted any
 * string for `signatureImagePngBase64` / `initialsImagePngBase64`, and a
 * failure to embed at seal time was swallowed with a warn-level log — the
 * result was a COMPLETED, sealed envelope with a blank signature box. This
 * module rejects malformed, oversized, or non-PNG payloads at the boundary
 * with a signer-facing message.
 *
 * The encoded size cap alone does not bound decode cost: pdf-lib decodes a
 * PNG into buffers sized from the IHDR width x height (roughly 8 bytes per
 * declared pixel held at once), so a sub-kilobyte file declaring 20000x20000
 * costs gigabytes at seal time. The declared dimensions (PNG IHDR, JPEG SOF)
 * are therefore bounded here too, and a PNG's image data must inflate to no
 * more than its declared size.
 *
 * Leaf module: reads its caps from `process.env` directly (same reasoning
 * as `src/lib/mail/allowlist.ts`) rather than importing `src/lib/env.ts`, so
 * it stays usable in tests that don't have a fully-validated app env.
 */

import { constants as zlibConstants, inflateSync } from 'node:zlib';

export type SignatureImageRejection =
  | 'not_base64'
  | 'not_png'
  | 'too_large'
  | 'empty'
  | 'format_not_allowed'
  | 'dimensions_too_large'
  | 'unreadable';

export interface SignatureImageCheck {
  ok: boolean;
  reason?: SignatureImageRejection;
  /** Signer-facing message. */
  message?: string;
  /** Decoded byte length, when it decoded at all. */
  byteLength?: number;
}

const DEFAULT_MAX_SIGNATURE_IMAGE_BYTES = 2097152;
/** Longest side, in pixels, of any image embedded into a sealed PDF. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 4096;
/** Width x height ceiling (8 MP, about 70 MB of transient pdf-lib decode buffers). */
export const DEFAULT_MAX_IMAGE_PIXELS = 8388608;

/** PNG file signature — required to be the first 8 bytes of the file. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG file signature — the first 3 bytes of any JPEG/JFIF/EXIF file. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxBytes(): number {
  return positiveIntFromEnv('MAX_SIGNATURE_IMAGE_BYTES', DEFAULT_MAX_SIGNATURE_IMAGE_BYTES);
}

export interface ImageDimensionLimits {
  maxDimension: number;
  maxPixels: number;
}

export function getImageDimensionLimits(): ImageDimensionLimits {
  return {
    maxDimension: positiveIntFromEnv('MAX_IMAGE_DIMENSION', DEFAULT_MAX_IMAGE_DIMENSION),
    maxPixels: positiveIntFromEnv('MAX_IMAGE_PIXELS', DEFAULT_MAX_IMAGE_PIXELS),
  };
}

const EMPTY_RESULT: SignatureImageCheck = {
  ok: false,
  reason: 'empty',
  message: 'No signature image was provided. Try drawing or typing your signature again.',
};

const NOT_BASE64_RESULT: SignatureImageCheck = {
  ok: false,
  reason: 'not_base64',
  message: 'That signature image could not be read. Try drawing or typing your signature again.',
};

const NOT_PNG_RESULT: SignatureImageCheck = {
  ok: false,
  reason: 'not_png',
  message: 'That signature image could not be read. Try drawing or typing your signature again.',
};

const FORMAT_NOT_ALLOWED_MESSAGE =
  'That image could not be read, or is not in a supported format.';

const UNREADABLE_MESSAGE = 'That image could not be read. Try drawing or uploading it again.';

export type EmbeddableImageFormat = 'png' | 'jpeg';

/** Detect the embeddable format from decoded bytes, if any. */
function detectEmbeddableFormat(decoded: Buffer): EmbeddableImageFormat | undefined {
  if (decoded.length >= PNG_MAGIC.length && decoded.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'png';
  }
  if (decoded.length >= JPEG_MAGIC.length && decoded.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return 'jpeg';
  }
  return undefined;
}

export type ImageInspection =
  | { ok: true; format: EmbeddableImageFormat; width: number; height: number }
  | { ok: false; reason: 'format_not_allowed' | 'dimensions_too_large' | 'unreadable'; detail: string };

function dimensionVerdict(
  format: EmbeddableImageFormat,
  width: number,
  height: number,
  limits: ImageDimensionLimits,
): ImageInspection | undefined {
  if (width === 0 || height === 0) {
    return { ok: false, reason: 'unreadable', detail: `${format} declares a zero dimension` };
  }
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
    return {
      ok: false,
      reason: 'dimensions_too_large',
      detail: `${format} declares ${width}x${height}; limit ${limits.maxDimension}px per side, ${limits.maxPixels} pixels`,
    };
  }
  return undefined;
}

const PNG_CHANNELS: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

// APNG frames carry their own width/height (fcTL), which the decoder trusts
// without checking against IHDR, and pdf-lib decodes every frame before
// refusing animation. IHDR (exactly one, first) and these are the only
// chunks UPNG.decode reads size or layout from; the rest are metadata tables.
const ANIMATION_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);

function inspectPng(buf: Buffer, limits: ImageDimensionLimits): ImageInspection {
  const unreadable = (detail: string): ImageInspection => ({ ok: false, reason: 'unreadable', detail });
  if (buf.length < 8 + 25 || buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') {
    return unreadable('png has no IHDR chunk');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24]!;
  const colorType = buf[25]!;
  const interlace = buf[28]!;
  const verdict = dimensionVerdict('png', width, height, limits);
  if (verdict) return verdict;
  const layout = PNG_CHANNELS[colorType];
  if (!layout || !layout.depths.includes(bitDepth) || buf[26] !== 0 || buf[27] !== 0 || interlace > 1) {
    return unreadable('png IHDR has an invalid colour type, depth, or method');
  }

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataEnd = offset + 8 + length;
    if (dataEnd + 4 > buf.length) return unreadable(`png chunk ${type} overruns the file`);
    if (ANIMATION_CHUNKS.has(type)) return unreadable('animated png is not supported');
    // pdf-lib's decoder (UPNG) re-reads every IHDR it meets before IEND, so
    // a later one would replace the width, height and layout checked above.
    if (type === 'IHDR' && offset !== 8) return unreadable('png has more than one IHDR chunk');
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, dataEnd));
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  if (idat.length === 0) return unreadable('png has no image data');

  // Inflate once with a hard output ceiling equal to the declared raw size,
  // so image data that would expand past it is refused instead of decoded.
  const rowBytes = Math.ceil((width * layout.channels * bitDepth) / 8);
  const maxRaw = interlace === 1 ? 2 * (rowBytes + 2) * height + 64 : (rowBytes + 1) * height;
  try {
    inflateSync(Buffer.concat(idat), { maxOutputLength: maxRaw, finishFlush: zlibConstants.Z_SYNC_FLUSH });
  } catch {
    return unreadable('png image data is corrupt or inflates past its declared size');
  }
  return { ok: true, format: 'png', width, height };
}

/** Start-of-frame markers that carry dimensions (SOF0-15 minus DHT, JPG, DAC). */
function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function inspectJpeg(buf: Buffer, limits: ImageDimensionLimits): ImageInspection {
  const unreadable = (detail: string): ImageInspection => ({ ok: false, reason: 'unreadable', detail });
  let offset = 2;
  while (offset + 2 <= buf.length) {
    if (buf[offset] !== 0xff) return unreadable('jpeg segment does not start with a marker');
    const marker = buf[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    offset += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buf.length) break;
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) return unreadable('jpeg segment overruns the file');
    if (isJpegSof(marker)) {
      if (length < 8) return unreadable('jpeg frame header is truncated');
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      return dimensionVerdict('jpeg', width, height, limits) ?? { ok: true, format: 'jpeg', width, height };
    }
    offset += length;
  }
  return unreadable('jpeg has no frame header before its image data');
}

/**
 * Identify an embeddable image from its bytes and bound its declared size.
 * Runs at submission (via `checkEmbeddableImage`) and again in the sealer
 * just before `embedPng`/`embedJpg`, for values stored before these checks
 * existed or arriving by another path.
 */
export function inspectEmbeddableImageBytes(
  bytes: Uint8Array,
  limits: ImageDimensionLimits = getImageDimensionLimits(),
): ImageInspection {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = detectEmbeddableFormat(buf);
  if (format === 'png') return inspectPng(buf, limits);
  if (format === 'jpeg') return inspectJpeg(buf, limits);
  return { ok: false, reason: 'format_not_allowed', detail: 'not a png or jpeg' };
}

/**
 * Validate a bare base64 image payload (strip any `data:` prefix first).
 * `allowed` is the set of formats the PDF sealer can actually embed — pdf-lib
 * has `embedPng` and `embedJpg` and nothing else, so anything outside this set
 * would seal as a blank box.
 */
export function checkEmbeddableImage(
  base64: string,
  allowed: readonly EmbeddableImageFormat[],
): SignatureImageCheck & { format?: EmbeddableImageFormat } {
  const cleaned = base64.replace(/\s+/g, '');

  if (cleaned.length === 0) {
    return EMPTY_RESULT;
  }

  if (!BASE64_SHAPE.test(cleaned) || cleaned.length % 4 !== 0) {
    return NOT_BASE64_RESULT;
  }

  const decoded = Buffer.from(cleaned, 'base64');

  // Node's base64 decoder is tolerant of some non-canonical input; round-trip
  // it to catch what the shape/length check above didn't.
  if (decoded.toString('base64') !== cleaned) {
    return NOT_BASE64_RESULT;
  }

  if (decoded.length === 0) {
    return EMPTY_RESULT;
  }

  const maxBytes = getMaxBytes();
  if (decoded.length > maxBytes) {
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
    return {
      ok: false,
      reason: 'too_large',
      message: `That signature image is too large (limit ${maxMb} MB). Try drawing it again.`,
      byteLength: decoded.length,
    };
  }

  const format = detectEmbeddableFormat(decoded);
  if (!format || !allowed.includes(format)) {
    return {
      ok: false,
      reason: 'format_not_allowed',
      message: FORMAT_NOT_ALLOWED_MESSAGE,
      byteLength: decoded.length,
    };
  }

  const inspection = inspectEmbeddableImageBytes(decoded);
  if (!inspection.ok) {
    if (inspection.reason === 'dimensions_too_large') {
      const { maxDimension, maxPixels } = getImageDimensionLimits();
      const megapixels = (maxPixels / 1_000_000).toFixed(1).replace(/\.0$/, '');
      return {
        ok: false,
        reason: 'dimensions_too_large',
        message: `That image is too large (limit ${maxDimension} pixels per side, ${megapixels} megapixels). Try drawing or uploading it again.`,
        byteLength: decoded.length,
      };
    }
    return { ok: false, reason: 'unreadable', message: UNREADABLE_MESSAGE, byteLength: decoded.length };
  }

  return { ok: true, byteLength: decoded.length, format };
}

/**
 * Decode a stored base64 image for the sealer, re-checking format and declared
 * dimensions before pdf-lib decodes it. Throws so callers' existing
 * embed-failure handling skips the image instead of exhausting memory.
 */
export function decodeStoredImageForEmbedding(
  base64: string,
  allowed: readonly EmbeddableImageFormat[],
): { bytes: Buffer; format: EmbeddableImageFormat; width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  const inspection = inspectEmbeddableImageBytes(bytes);
  if (!inspection.ok) throw new Error(`refusing to embed image: ${inspection.detail}`);
  if (!allowed.includes(inspection.format)) {
    throw new Error(`refusing to embed image: ${inspection.format} is not allowed for this field`);
  }
  return { bytes, format: inspection.format, width: inspection.width, height: inspection.height };
}

/** The slice of pdf-lib's PDFDocument the sealer's image embedding uses. */
interface ImageEmbeddingDoc<I extends { width: number; height: number }> {
  embedPng(bytes: Uint8Array): Promise<I>;
  embedJpg(bytes: Uint8Array): Promise<I>;
}

/**
 * Re-check a stored image, embed it, and confirm pdf-lib decoded it at the
 * dimensions that were checked. A mismatch means the inspection and the
 * decoder disagree about the file (as a second IHDR once made them), so the
 * image is refused rather than drawn.
 */
export async function embedStoredImage<I extends { width: number; height: number }>(
  doc: ImageEmbeddingDoc<I>,
  base64: string,
  allowed: readonly EmbeddableImageFormat[],
): Promise<I> {
  const checked = decodeStoredImageForEmbedding(base64, allowed);
  const img = checked.format === 'jpeg' ? await doc.embedJpg(checked.bytes) : await doc.embedPng(checked.bytes);
  if (img.width !== checked.width || img.height !== checked.height) {
    throw new Error(
      `refusing to embed image: decoded as ${img.width}x${img.height}, checked as ${checked.width}x${checked.height}`,
    );
  }
  return img;
}

/**
 * Validate a bare base64 PNG payload (no data: prefix — strip it first).
 */
export function checkSignatureImage(base64: string): SignatureImageCheck {
  const result = checkEmbeddableImage(base64, ['png']);
  if (!result.ok && result.reason === 'format_not_allowed') {
    return { ...NOT_PNG_RESULT, byteLength: result.byteLength };
  }
  const { format: _format, ...rest } = result;
  return rest;
}
