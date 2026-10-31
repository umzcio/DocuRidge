import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { deflateSync, crc32 } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import {
  DEFAULT_SEAL_MAX_IMAGE_BYTES,
  assertSealImageBudget,
  assertSealImageBytes,
  checkSignatureImage,
  checkEmbeddableImage,
  decodeStoredImageForEmbedding,
  embedStoredImage,
  inspectEmbeddableImageBytes,
} from './signature-image';
import { PdfComplexityError } from '../pdf/seal-limits';

const ORIGINAL_MAX = process.env.MAX_SIGNATURE_IMAGE_BYTES;

/** Assemble one PNG chunk (length, type, data, CRC). */
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * Build a PNG with an arbitrary IHDR. `idat` defaults to a correctly sized
 * all-zero scanline payload, so small images decode for real; callers
 * crafting hostile files pass their own.
 */
function makePng(opts: {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: number;
  idat?: Buffer;
  extraChunks?: Buffer[];
  extraBytes?: number;
} = {}): Buffer {
  const width = opts.width ?? 1;
  const height = opts.height ?? 1;
  const bitDepth = opts.bitDepth ?? 8;
  const colorType = opts.colorType ?? 6;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 4;
  const idat = opts.idat
    ?? deflateSync(Buffer.alloc((Math.ceil((width * channels * bitDepth) / 8) + 1) * height));
  const padding = opts.extraBytes ? [pngChunk('tEXt', Buffer.alloc(opts.extraBytes, 0x61))] : [];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(opts.extraChunks ?? []),
    ...padding,
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makePngBuffer(extraBytes = 0): Buffer {
  return makePng({ extraBytes });
}

/** A JPEG skeleton: SOI, APP0, and a SOF0 segment carrying the dimensions. */
function makeJpegBuffer(width = 1, height = 1): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * Build a minimal WebP buffer: `RIFF` at offset 0, a 4-byte chunk size, then
 * `WEBP` at offset 8. checkEmbeddableImage only inspects the leading magic
 * bytes for png/jpeg detection, so this is sufficient to prove WebP is
 * neither.
 */
function makeWebpBuffer(): Buffer {
  const riff = Buffer.from('RIFF', 'ascii');
  const size = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const webp = Buffer.from('WEBP', 'ascii');
  const tail = Buffer.from([0x56, 0x50, 0x38, 0x20]); // "VP8 "
  return Buffer.concat([riff, size, webp, tail]);
}

function toBase64(buf: Buffer): string {
  return buf.toString('base64');
}

describe('checkSignatureImage', () => {
  beforeEach(() => {
    delete process.env.MAX_SIGNATURE_IMAGE_BYTES;
  });

  afterAll(() => {
    if (ORIGINAL_MAX === undefined) {
      delete process.env.MAX_SIGNATURE_IMAGE_BYTES;
    } else {
      process.env.MAX_SIGNATURE_IMAGE_BYTES = ORIGINAL_MAX;
    }
  });

  it('accepts a valid base64 PNG', () => {
    const png = makePngBuffer();
    const result = checkSignatureImage(toBase64(png));
    expect(result.ok).toBe(true);
    expect(result.byteLength).toBe(png.length);
  });

  it("rejects 'hello' as not_base64 — the exact payload today's code accepts", () => {
    const result = checkSignatureImage('hello');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_base64');
  });

  it('rejects "!!!!" (invalid base64 characters) as not_base64', () => {
    const result = checkSignatureImage('!!!!');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_base64');
  });

  it('rejects "a" (length not a multiple of 4) as not_base64', () => {
    const result = checkSignatureImage('a');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_base64');
  });

  it('rejects "AAA=AAAA" (padding in the middle) as not_base64', () => {
    const result = checkSignatureImage('AAA=AAAA');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_base64');
  });

  it('rejects an empty string as empty', () => {
    const result = checkSignatureImage('');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('rejects a whitespace-only string as empty', () => {
    const result = checkSignatureImage('   ');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('rejects a valid base64 JPEG as not_png — proving the check is on decoded bytes', () => {
    const result = checkSignatureImage(toBase64(makeJpegBuffer()));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_png');
  });

  it('rejects valid base64 of arbitrary non-PNG bytes as not_png', () => {
    const result = checkSignatureImage(toBase64(Buffer.from('just some random bytes here')));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_png');
  });

  it('rejects a valid base64 PNG exceeding the cap as too_large', () => {
    process.env.MAX_SIGNATURE_IMAGE_BYTES = '64';
    const png = makePngBuffer(100);
    const result = checkSignatureImage(toBase64(png));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_large');
    expect(result.message).toMatch(/too large/i);
  });

  it('accepts a payload exactly at the cap (boundary is inclusive)', () => {
    const png = makePngBuffer();
    process.env.MAX_SIGNATURE_IMAGE_BYTES = String(png.length);
    const result = checkSignatureImage(toBase64(png));
    expect(result.ok).toBe(true);
    expect(result.byteLength).toBe(png.length);
  });

  it('accepts base64 containing embedded newlines/whitespace after cleaning', () => {
    const png = makePngBuffer();
    const raw = toBase64(png);
    const wrapped = raw.match(/.{1,10}/g)!.join('\n');
    const result = checkSignatureImage(wrapped);
    expect(result.ok).toBe(true);
    expect(result.byteLength).toBe(png.length);
  });
});

describe('checkEmbeddableImage', () => {
  beforeEach(() => {
    delete process.env.MAX_SIGNATURE_IMAGE_BYTES;
  });

  afterAll(() => {
    if (ORIGINAL_MAX === undefined) {
      delete process.env.MAX_SIGNATURE_IMAGE_BYTES;
    } else {
      process.env.MAX_SIGNATURE_IMAGE_BYTES = ORIGINAL_MAX;
    }
  });

  it('accepts PNG bytes when only png is allowed', () => {
    const png = makePngBuffer();
    const result = checkEmbeddableImage(toBase64(png), ['png']);
    expect(result.ok).toBe(true);
    expect(result.format).toBe('png');
  });

  it('accepts PNG bytes when png and jpeg are both allowed', () => {
    const png = makePngBuffer();
    const result = checkEmbeddableImage(toBase64(png), ['png', 'jpeg']);
    expect(result.ok).toBe(true);
    expect(result.format).toBe('png');
  });

  it('accepts JPEG bytes when png and jpeg are both allowed', () => {
    const jpeg = makeJpegBuffer();
    const result = checkEmbeddableImage(toBase64(jpeg), ['png', 'jpeg']);
    expect(result.ok).toBe(true);
    expect(result.format).toBe('jpeg');
  });

  it('rejects JPEG bytes when only png is allowed — a JPEG must not sneak into a PNG-only path', () => {
    const jpeg = makeJpegBuffer();
    const result = checkEmbeddableImage(toBase64(jpeg), ['png']);
    expect(result.ok).toBe(false);
  });

  it('rejects WebP bytes even when png and jpeg are both allowed — pdf-lib cannot embed WebP', () => {
    const webp = makeWebpBuffer();
    const result = checkEmbeddableImage(toBase64(webp), ['png', 'jpeg']);
    expect(result.ok).toBe(false);
  });

  it('rejects arbitrary non-image bytes', () => {
    const result = checkEmbeddableImage(
      toBase64(Buffer.from('just some random bytes here')),
      ['png', 'jpeg'],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects 'hello' as not-base64", () => {
    const result = checkEmbeddableImage('hello', ['png', 'jpeg']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_base64');
  });

  it('rejects a payload exceeding the cap as too_large', () => {
    process.env.MAX_SIGNATURE_IMAGE_BYTES = '64';
    const png = makePngBuffer(100);
    const result = checkEmbeddableImage(toBase64(png), ['png', 'jpeg']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_large');
  });
});

describe('image dimension limits', () => {
  const ORIGINAL_DIM = process.env.MAX_IMAGE_DIMENSION;
  const ORIGINAL_PIXELS = process.env.MAX_IMAGE_PIXELS;

  beforeEach(() => {
    delete process.env.MAX_SIGNATURE_IMAGE_BYTES;
    delete process.env.MAX_IMAGE_DIMENSION;
    delete process.env.MAX_IMAGE_PIXELS;
  });

  afterAll(() => {
    for (const [k, v] of [['MAX_IMAGE_DIMENSION', ORIGINAL_DIM], ['MAX_IMAGE_PIXELS', ORIGINAL_PIXELS]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('rejects a sub-kilobyte PNG whose IHDR declares 20000x20000 (decompression bomb)', () => {
    // 1-bit greyscale with an almost empty IDAT: decoder cost follows the
    // declared size, not the file size.
    const bomb = makePng({ width: 20000, height: 20000, bitDepth: 1, colorType: 0, idat: deflateSync(Buffer.alloc(16)) });
    expect(bomb.length).toBeLessThan(1024);

    const sig = checkSignatureImage(toBase64(bomb));
    expect(sig.ok).toBe(false);
    expect(sig.reason).toBe('dimensions_too_large');

    const drawing = checkEmbeddableImage(toBase64(bomb), ['png']);
    expect(drawing.ok).toBe(false);
    expect(drawing.reason).toBe('dimensions_too_large');
  });

  it('rejects a PNG under the per-side cap whose pixel count exceeds the area cap', () => {
    const wide = makePng({ width: 4000, height: 4000, bitDepth: 1, colorType: 0, idat: deflateSync(Buffer.alloc(16)) });
    const result = checkEmbeddableImage(toBase64(wide), ['png']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('dimensions_too_large');
  });

  it('accepts a real signature-pad-sized PNG', () => {
    const png = makePng({ width: 1800, height: 600 });
    const result = checkSignatureImage(toBase64(png));
    expect(result.ok).toBe(true);
  });

  it('rejects a small-dimension PNG whose IDAT inflates far past the declared size', () => {
    const png = makePng({ width: 1, height: 1, idat: deflateSync(Buffer.alloc(4 * 1024 * 1024)) });
    const result = checkSignatureImage(toBase64(png));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable');
  });

  it('rejects an animated PNG (frames carry their own unchecked dimensions)', () => {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(1, 0);
    const png = makePng({ extraChunks: [pngChunk('acTL', actl)] });
    const result = checkEmbeddableImage(toBase64(png), ['png']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable');
  });

  it('rejects a PNG with a second IHDR (pdf-lib decodes at the last IHDR it sees)', () => {
    // 1x1 first IHDR passes the dimension check; UPNG then overwrites the
    // size with the 6000x6000 second IHDR and decodes 36 MP.
    const second = Buffer.alloc(13);
    second.writeUInt32BE(6000, 0);
    second.writeUInt32BE(6000, 4);
    second[8] = 8;
    second[9] = 0;
    const png = makePng({ bitDepth: 8, colorType: 0, extraChunks: [pngChunk('IHDR', second)], idat: deflateSync(Buffer.from([0, 0])) });
    expect(png.length).toBeLessThan(128);

    const sig = checkSignatureImage(toBase64(png));
    expect(sig.ok).toBe(false);
    expect(sig.reason).toBe('unreadable');
    expect(checkEmbeddableImage(toBase64(png), ['png', 'jpeg']).ok).toBe(false);
    expect(inspectEmbeddableImageBytes(png)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('rejects a duplicate IHDR placed after the image data', () => {
    const base = makePng({ width: 2, height: 2 });
    const iend = base.subarray(base.length - 12);
    const lateIhdr = base.subarray(8, 8 + 25);
    const png = Buffer.concat([base.subarray(0, base.length - 12), lateIhdr, iend]);
    expect(checkEmbeddableImage(toBase64(png), ['png']).ok).toBe(false);
  });

  it('ignores chunks after IEND, as the decoder does', () => {
    const base = makePng({ width: 2, height: 2 });
    const trailing = pngChunk('IHDR', Buffer.alloc(13, 0xff));
    expect(checkEmbeddableImage(toBase64(Buffer.concat([base, trailing])), ['png']).ok).toBe(true);
  });

  it('rejects a PNG with no image data', () => {
    const noIdat = makePng().subarray(0, 8 + 25);
    expect(checkEmbeddableImage(toBase64(noIdat), ['png']).ok).toBe(false);
  });

  it('rejects a JPEG whose SOF declares 65535x65535', () => {
    const result = checkEmbeddableImage(toBase64(makeJpegBuffer(65535, 65535)), ['png', 'jpeg']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('dimensions_too_large');
  });

  it('rejects a JPEG with no SOF segment', () => {
    const noSof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
    const result = checkEmbeddableImage(toBase64(noSof), ['png', 'jpeg']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable');
  });

  it('honours MAX_IMAGE_DIMENSION / MAX_IMAGE_PIXELS overrides', () => {
    process.env.MAX_IMAGE_DIMENSION = '100';
    expect(checkSignatureImage(toBase64(makePng({ width: 101, height: 10 }))).reason).toBe('dimensions_too_large');
    expect(checkSignatureImage(toBase64(makePng({ width: 100, height: 10 }))).ok).toBe(true);
    process.env.MAX_IMAGE_DIMENSION = '10000';
    process.env.MAX_IMAGE_PIXELS = '50';
    expect(checkSignatureImage(toBase64(makePng({ width: 10, height: 6 }))).reason).toBe('dimensions_too_large');
  });

  it('inspectEmbeddableImageBytes reports format and dimensions for the sealer re-check', () => {
    expect(inspectEmbeddableImageBytes(makePng({ width: 3, height: 2 }))).toEqual({ ok: true, format: 'png', width: 3, height: 2 });
    expect(inspectEmbeddableImageBytes(makeJpegBuffer(640, 480))).toEqual({ ok: true, format: 'jpeg', width: 640, height: 480 });
    const bomb = makePng({ width: 20000, height: 20000, bitDepth: 1, colorType: 0, idat: deflateSync(Buffer.alloc(16)) });
    expect(inspectEmbeddableImageBytes(bomb)).toMatchObject({ ok: false, reason: 'dimensions_too_large' });
    expect(inspectEmbeddableImageBytes(Buffer.from('not an image'))).toMatchObject({ ok: false, reason: 'format_not_allowed' });
  });
});

describe('decodeStoredImageForEmbedding (sealer re-check)', () => {
  beforeEach(() => {
    delete process.env.MAX_IMAGE_DIMENSION;
    delete process.env.MAX_IMAGE_PIXELS;
  });

  it('throws on a stored oversized-dimension PNG before pdf-lib decodes it', () => {
    const bomb = makePng({ width: 20000, height: 20000, bitDepth: 1, colorType: 0, idat: deflateSync(Buffer.alloc(16)) });
    expect(() => decodeStoredImageForEmbedding(toBase64(bomb), ['png'])).toThrow(/refusing to embed/);
  });

  it('throws on a stored double-IHDR PNG before pdf-lib decodes it', () => {
    const second = Buffer.alloc(13);
    second.writeUInt32BE(6000, 0);
    second.writeUInt32BE(6000, 4);
    second[8] = 8;
    second[9] = 0;
    const png = makePng({ bitDepth: 8, colorType: 0, extraChunks: [pngChunk('IHDR', second)], idat: deflateSync(Buffer.from([0, 0])) });
    expect(() => decodeStoredImageForEmbedding(toBase64(png), ['png'])).toThrow(/refusing to embed/);
    expect(() => decodeStoredImageForEmbedding(toBase64(png), ['png', 'jpeg'])).toThrow(/refusing to embed/);
  });

  it('throws when the stored bytes are a format the field may not embed', () => {
    expect(() => decodeStoredImageForEmbedding(toBase64(makeJpegBuffer()), ['png'])).toThrow(/not allowed/);
  });

  it('embedStoredImage refuses a double-IHDR PNG before pdf-lib decodes it', async () => {
    const second = Buffer.alloc(13);
    second.writeUInt32BE(6000, 0);
    second.writeUInt32BE(6000, 4);
    second[8] = 8;
    second[9] = 0;
    const png = makePng({ bitDepth: 8, colorType: 0, extraChunks: [pngChunk('IHDR', second)], idat: deflateSync(Buffer.from([0, 0])) });
    const doc = await PDFDocument.create();
    const embedPng = vi.spyOn(doc, 'embedPng');
    await expect(embedStoredImage(doc, toBase64(png), ['png'])).rejects.toThrow(/refusing to embed/);
    expect(embedPng).not.toHaveBeenCalled();
  });

  it('embedStoredImage refuses an image the decoder sizes differently from the check', async () => {
    const fakeDoc = {
      embedPng: async () => ({ width: 6000, height: 6000 }),
      embedJpg: async () => ({ width: 6000, height: 6000 }),
    };
    await expect(embedStoredImage(fakeDoc, toBase64(makePng({ width: 4, height: 4 })), ['png'])).rejects.toThrow(
      /decoded as 6000x6000, checked as 4x4/,
    );
  });

  it('embedStoredImage embeds an accepted PNG at its checked size', async () => {
    const doc = await PDFDocument.create();
    const png = await embedStoredImage(doc, toBase64(makePng({ width: 40, height: 20 })), ['png', 'jpeg']);
    expect([png.width, png.height]).toEqual([40, 20]);
  });

  it('returns bytes pdf-lib can embed for an accepted PNG', async () => {
    const { bytes, format } = decodeStoredImageForEmbedding(toBase64(makePng({ width: 40, height: 20 })), ['png']);
    expect(format).toBe('png');
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(bytes);
    expect([img.width, img.height]).toEqual([40, 20]);
  });
});

describe('the seal image byte budget', () => {
  /**
   * A 1x1 PNG padded with an ancillary chunk to exactly `total` bytes, made
   * distinct by `i`: it passes every per-image check and adds one pixel to
   * the pixel budget, whatever its size.
   */
  function paddedPng(i: number, total: number): string {
    const bare = makePng();
    const pad = Buffer.alloc(total - bare.length - 12, 0x41);
    pad.writeUInt32BE(i, 0);
    // After the signature (8 bytes) and IHDR (25), before IDAT.
    return toBase64(Buffer.concat([bare.subarray(0, 33), pngChunk('prVt', pad), bare.subarray(33)]));
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 32 MiB of stored image text', () => {
    expect(DEFAULT_SEAL_MAX_IMAGE_BYTES).toBe(32 * 1024 * 1024);
  });

  it('refuses sixty distinct 2 MiB padded PNGs, which the pixel budget alone accepts', () => {
    const images = Array.from({ length: 60 }, (_, i) => paddedPng(i, 2097152));
    for (const image of images.slice(0, 2)) expect(checkEmbeddableImage(image, ['png']).ok).toBe(true);

    const err = (() => {
      try {
        assertSealImageBudget(images);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('seal_image_bytes');
  });

  it('counts every stored copy, duplicates included', () => {
    vi.stubEnv('SEAL_MAX_IMAGE_BYTES', '100');
    const image = 'A'.repeat(40);
    expect(() => assertSealImageBytes([image, image])).not.toThrow();
    expect(() => assertSealImageBytes([image, image, image])).toThrow(/more than 100 bytes/);
  });

  it('leaves room for ordinary signing: fifty recipients with four 50 KB images each', () => {
    const images = Array.from({ length: 200 }, (_, i) => paddedPng(i, 50 * 1024));
    expect(() => assertSealImageBudget(images)).not.toThrow();
  });
});
