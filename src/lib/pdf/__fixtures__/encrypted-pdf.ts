/**
 * Test fixture: a really encrypted PDF (standard security handler, empty user
 * password), built here rather than with qpdf so the tests need no binary.
 *
 * One page whose content stream is unfiltered and draws ENCRYPTED_PDF_TEXT,
 * so a pipeline that copies the ciphertext as if it were content cannot get
 * lucky the way a FlateDecode stream (which fails to inflate) would.
 *   - `rc4`: /V 2 /R 3, 128-bit RC4 (PDF 1.4).
 *   - `aes`: /V 4 /R 4, AESV2 crypt filter (AES-128-CBC, PDF 1.6).
 * Key derivation follows ISO 32000-1 §7.6.3 (algorithms 1, 2, 3 and 5).
 */
import { createCipheriv, createHash } from 'node:crypto';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream } from 'pdf-lib';

export const ENCRYPTED_PDF_TEXT = 'HELLO SIGNER';

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();

/** RC4 (OpenSSL 3 no longer offers it by default). */
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

/** RC4 with the key XORed with 1..19 in turn (the R3+ iterations). */
function rc4Rounds(key: Buffer, data: Buffer): Buffer {
  let out = rc4(key, data);
  for (let i = 1; i <= 19; i++) out = rc4(Buffer.from(key.map((b) => b ^ i)), out);
  return out;
}

function int32le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
}

/**
 * `extraStream`, when given, is stored (and encrypted) as is, with its own
 * /Filter, and named from the catalog as /Extra: a stream qpdf would decode
 * and re-encode unless told to keep stream data as it is.
 */
export async function encryptedPdf(
  cipher: 'rc4' | 'aes',
  extraStream?: { filter: string[]; data: Uint8Array },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 200]);
  const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { Helvetica: font } } as never));
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.stream(`BT /Helvetica 24 Tf 40 100 Td (${ENCRYPTED_PDF_TEXT}) Tj ET`)),
  );
  if (extraStream) {
    const dict = doc.context.obj({ Filter: extraStream.filter, Length: extraStream.data.length }) as PDFDict;
    doc.catalog.set(PDFName.of('Extra'), doc.context.register(PDFRawStream.of(dict, extraStream.data)));
  }

  const id = Buffer.alloc(16, 0x5a);
  const permissions = -4;
  // Algorithm 3: /O from the owner password "owner".
  let ownerHash = md5(Buffer.concat([Buffer.from('owner', 'latin1'), PAD]).subarray(0, 32));
  for (let i = 0; i < 50; i++) ownerHash = md5(ownerHash);
  const O = rc4Rounds(ownerHash.subarray(0, 16), PAD);
  // Algorithm 2: the file key from the empty user password.
  let keyHash = md5(PAD, O, int32le(permissions), id);
  for (let i = 0; i < 50; i++) keyHash = md5(keyHash.subarray(0, 16));
  const key = keyHash.subarray(0, 16);
  // Algorithm 5: /U.
  const U = Buffer.concat([rc4Rounds(key, md5(PAD, id)), Buffer.alloc(16)]);

  // Algorithm 1: encrypt every stream with its object key. (No strings are
  // left to encrypt: no Info, and the content is in the stream.)
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const objectId = Buffer.from([
      ref.objectNumber & 255, (ref.objectNumber >> 8) & 255, (ref.objectNumber >> 16) & 255,
      ref.generationNumber & 255, (ref.generationNumber >> 8) & 255,
    ]);
    const plain = Buffer.from(object.contents);
    let encrypted: Buffer;
    if (cipher === 'rc4') {
      encrypted = rc4(md5(key, objectId).subarray(0, 16), plain);
    } else {
      const objectKey = md5(key, objectId, Buffer.from('sAlT', 'latin1')).subarray(0, 16);
      const iv = Buffer.alloc(16, ref.objectNumber);
      const aes = createCipheriv('aes-128-cbc', objectKey, iv);
      encrypted = Buffer.concat([iv, aes.update(plain), aes.final()]);
    }
    doc.context.assign(ref, PDFRawStream.of(object.dict, encrypted));
  }

  const handler =
    cipher === 'rc4'
      ? { Filter: 'Standard', V: 2, R: 3, Length: 128 }
      : {
          Filter: 'Standard', V: 4, R: 4, Length: 128,
          CF: { StdCF: { CFM: 'AESV2', Length: 16, AuthEvent: 'DocOpen' } }, StmF: 'StdCF', StrF: 'StdCF',
        };
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({
    ...handler, P: permissions, O: PDFHexString.of(O.toString('hex')), U: PDFHexString.of(U.toString('hex')),
  } as never));
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id.toString('hex')), PDFHexString.of(id.toString('hex'))]);
  return doc.save({ useObjectStreams: false });
}
