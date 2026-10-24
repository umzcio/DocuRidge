/**
 * Test fixtures: byte-level edits to a sealed PDF that pdf-lib's load/save
 * cannot express — incremental updates, duplicate object definitions and
 * hand-built cross-reference tables. Each produces a file a viewer reads
 * through its xref while pdf-lib reads it front to back.
 */
import { PDFArray, PDFDocument, PDFName, PDFObject, PDFRef } from 'pdf-lib';

export function serialize(obj: PDFObject): Buffer {
  const buf = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(buf, 0);
  return Buffer.from(buf);
}

/** The first content stream of page `index`. */
export function pageContentRef(doc: PDFDocument, index = 0): PDFRef {
  const contents = doc.getPage(index).node.get(PDFName.of('Contents'));
  const ref = contents instanceof PDFArray ? contents.get(0) : contents;
  if (!(ref instanceof PDFRef)) throw new Error('page has no indirect content stream');
  return ref;
}

/** A content stream that draws `text`, serialized as an object body. */
export function forgedContentStream(doc: PDFDocument, text: string): Buffer {
  return serialize(doc.context.flateStream(`BT /Helvetica 24 Tf 50 650 Td (${text}) Tj ET`));
}

function lastStartxref(bytes: Uint8Array): number {
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 64))).toString('latin1');
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!m) throw new Error('no startxref at end of file');
  return Number(m[1]);
}

function xrefTable(entries: { num: number; gen: number; offset: number }[]): string {
  let out = 'xref\n';
  for (const e of [...entries].sort((a, b) => a.num - b.num)) {
    out += `${e.num} 1\n${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n \n`;
  }
  return out;
}

/**
 * Append an incremental update holding `objects` in order. The new xref lists
 * each object number once, at the copy marked `listed` (default: the first
 * copy of that number).
 */
export async function appendIncrementalUpdate(
  bytes: Uint8Array,
  objects: { num: number; gen?: number; body: Buffer; listed?: boolean }[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const parts: Buffer[] = [Buffer.from(bytes), Buffer.from('\n', 'latin1')];
  let length = bytes.length + 1;
  const entries = new Map<number, { num: number; gen: number; offset: number }>();
  for (const o of objects) {
    const gen = o.gen ?? 0;
    const listed = o.listed ?? !entries.has(o.num);
    if (listed) entries.set(o.num, { num: o.num, gen, offset: length });
    const chunk = Buffer.concat([Buffer.from(`${o.num} ${gen} obj\n`, 'latin1'), o.body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  }
  const xrefAt = length;
  const size = Math.max(doc.context.largestObjectNumber, ...objects.map((o) => o.num)) + 1;
  parts.push(Buffer.from(
    `${xrefTable([...entries.values()])}trailer\n<< /Size ${size} /Root ${String(doc.context.trailerInfo.Root)} /Prev ${lastStartxref(bytes)} >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(parts);
}

/**
 * Rewrite the document as a single revision with a classic xref table and
 * every object top-level. `before` inserts extra definitions ahead of the
 * genuine object with that number; `xrefOffset` may move any entry.
 */
export async function rewriteSingleRevision(
  bytes: Uint8Array,
  opts: {
    before?: Map<number, Buffer>;
    extra?: { num: number; body: Buffer }[];
    xrefOffset?: (num: number, offsets: Map<string, number>) => number | undefined;
  } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const parts: Buffer[] = [];
  let length = 0;
  const push = (buf: Buffer) => {
    parts.push(buf);
    length += buf.length;
  };
  /** "<num>" for the genuine definition, "<num>:inserted" / "<num>:extra" for the others. */
  const offsets = new Map<string, number>();
  const writeObject = (key: string, num: number, gen: number, body: Buffer) => {
    offsets.set(key, length);
    push(Buffer.concat([Buffer.from(`${num} ${gen} obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]));
  };

  push(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  const objects = doc.context.enumerateIndirectObjects().sort(([a], [b]) => a.objectNumber - b.objectNumber);
  for (const [ref, obj] of objects) {
    const inserted = opts.before?.get(ref.objectNumber);
    if (inserted) writeObject(`${ref.objectNumber}:inserted`, ref.objectNumber, ref.generationNumber, inserted);
    writeObject(String(ref.objectNumber), ref.objectNumber, ref.generationNumber, serialize(obj));
  }
  for (const e of opts.extra ?? []) writeObject(`${e.num}:extra`, e.num, 0, e.body);

  const entries = [...objects.map(([ref]) => ({ num: ref.objectNumber, gen: ref.generationNumber })), ...(opts.extra ?? []).map((e) => ({ num: e.num, gen: 0 }))]
    .map(({ num, gen }) => {
      const key = offsets.has(`${num}:extra`) ? `${num}:extra` : offsets.has(`${num}:inserted`) ? `${num}:inserted` : String(num);
      return { num, gen, offset: opts.xrefOffset?.(num, offsets) ?? offsets.get(key)! };
    });
  const xrefAt = length;
  const size = Math.max(...entries.map((e) => e.num)) + 1;
  const info = doc.context.trailerInfo.Info ? ` /Info ${String(doc.context.trailerInfo.Info)}` : '';
  push(Buffer.from(
    `xref\n0 1\n0000000000 65535 f \n${xrefTable(entries).slice('xref\n'.length)}trailer\n<< /Size ${size} /Root ${String(doc.context.trailerInfo.Root)}${info} >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(parts);
}
