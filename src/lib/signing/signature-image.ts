/**
 * Validate a recipient-supplied signature/initials image before it is ever
 * persisted or embedded into a sealed PDF. Previously the schema accepted any
 * string for `signatureImagePngBase64` / `initialsImagePngBase64`, and a
 * failure to embed at seal time was swallowed with a warn-level log — the
 * result was a COMPLETED, sealed envelope with a blank signature box. This
 * module rejects malformed, oversized, or non-PNG payloads at the boundary
 * with a signer-facing message.
 *
 * Leaf module: reads the size cap from `process.env` directly (same reasoning
 * as `src/lib/mail/allowlist.ts`) rather than importing `src/lib/env.ts`, so
 * it stays usable in tests that don't have a fully-validated app env.
 */

export type SignatureImageRejection =
  | 'not_base64'
  | 'not_png'
  | 'too_large'
  | 'empty'
  | 'format_not_allowed';

export interface SignatureImageCheck {
  ok: boolean;
  reason?: SignatureImageRejection;
  /** Signer-facing message. */
  message?: string;
  /** Decoded byte length, when it decoded at all. */
  byteLength?: number;
}

const DEFAULT_MAX_SIGNATURE_IMAGE_BYTES = 2097152;

/** PNG file signature — required to be the first 8 bytes of the file. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG file signature — the first 3 bytes of any JPEG/JFIF/EXIF file. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

function getMaxBytes(): number {
  const raw = process.env.MAX_SIGNATURE_IMAGE_BYTES;
  if (!raw) return DEFAULT_MAX_SIGNATURE_IMAGE_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SIGNATURE_IMAGE_BYTES;
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

  return { ok: true, byteLength: decoded.length, format };
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
