import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { checkSignatureImage, checkEmbeddableImage } from './signature-image';

const ORIGINAL_MAX = process.env.MAX_SIGNATURE_IMAGE_BYTES;

/**
 * Build a genuine minimal PNG buffer: the 8-byte PNG signature followed by a
 * short IHDR-shaped tail. checkSignatureImage only inspects the signature
 * bytes, so this is sufficient without pasting a real image blob.
 */
function makePngBuffer(extraBytes = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrTail = Buffer.from([
    0x00, 0x00, 0x00, 0x0d, // length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width
    0x00, 0x00, 0x00, 0x01, // height
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color type, compression, filter, interlace
  ]);
  const padding = extraBytes > 0 ? Buffer.alloc(extraBytes, 0xab) : Buffer.alloc(0);
  return Buffer.concat([signature, ihdrTail, padding]);
}

function makeJpegBuffer(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
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
