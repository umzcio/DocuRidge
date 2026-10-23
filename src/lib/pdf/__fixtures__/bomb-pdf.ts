/** Test fixtures: hand-built PDFs carrying nested-FlateDecode bombs. */
import { deflateSync } from 'node:zlib';

/** Nested FlateDecode: `decodedBytes` of zeros, deflated twice. */
export function doubleFlate(decodedBytes: number): Buffer {
  return deflateSync(deflateSync(Buffer.alloc(decodedBytes)));
}

/**
 * Assemble a one-page PDF by hand so the hostile stream can sit exactly where
 * the attack puts it: in an /ObjStm (decoded by PDFDocument.load) or in the
 * page /Contents (decoded only when the page is embedded, i.e. at seal time).
 */
export function buildBombPdf(where: 'objstm' | 'contents', payload: Buffer): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Buffer) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(buf);
    length += buf.length;
  };
  const object = (num: number, body: string, stream?: Buffer) => {
    offsets[num] = length;
    push(`${num} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const filter = '/Filter [/FlateDecode /FlateDecode]';
  if (where === 'contents') {
    object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>');
    object(4, `<< /Length ${payload.length} ${filter} >>`, payload);
  } else {
    object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>');
    object(4, '<< /Length 0 >>', Buffer.alloc(0));
    object(5, `<< /Type /ObjStm /N 1 /First 4 /Length ${payload.length} ${filter} >>`, payload);
  }
  const size = offsets.length;
  const xrefAt = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let i = 1; i < size; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(parts);
}
