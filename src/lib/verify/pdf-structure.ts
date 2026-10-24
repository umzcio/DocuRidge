/**
 * File-structure check for a sealed PDF: the bytes must hold exactly one
 * unambiguous set of objects, the one every reader resolves.
 *
 * pdf-lib (which reads the manifest and computes the content digest) parses
 * a file front to back and keeps the LAST definition of each object number;
 * it ignores the cross-reference table. Viewers such as pdf.js start at the
 * final `startxref` and fetch each object at the offset the xref chain gives.
 * A file can satisfy both views with different content: an appended update
 * whose xref points a page's content stream at a forged copy, followed by a
 * verbatim genuine copy that pdf-lib keeps; or forged objects prepended to the
 * genuine body with a rebuilt xref. The digest then covers what pdf-lib read
 * while the viewer renders the forgery.
 *
 * The sealer writes one revision with pdf-lib: header, objects (most in
 * object streams), one cross-reference stream, `startxref`, `%%EOF`. A
 * pdf-lib load/save round trip writes the same shape. So this check refuses
 * anything else:
 *
 *   post_seal_revision  more than one cross-reference section or `startxref`,
 *                       a `/Prev` or `/XRefStm` link, or bytes after the final
 *                       `%%EOF` (an incremental update, or an attempt at one)
 *   duplicate_object    an object number defined more than once, at the top
 *                       level or inside object streams
 *   xref_mismatch       the cross-reference table and the parsed objects
 *                       disagree: an entry pointing anywhere but the start of
 *                       that object's definition (or the wrong object-stream
 *                       slot), an object pdf-lib parsed that the table does
 *                       not list, a listed object the file does not define,
 *                       `startxref` not pointing at the table, or a `/Root`
 *                       other than the one pdf-lib uses
 *   pdf_structure       not parseable as a PDF without recovery
 *
 * When all of that holds, the object pdf-lib holds for every number is the
 * one a conforming reader fetches through the xref, so the digest and the
 * rendered document are the same objects.
 *
 * This applies to every manifest and digest version: it hardens the
 * verifier, it is not part of the signed digest.
 */

import {
  PDFContext,
  PDFDict,
  PDFName,
  PDFObject,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFXRefStreamParser,
} from 'pdf-lib';
import { PdfDecodeLimitError, withPdfDecodeBudget } from '../pdf/decode-limits';

export type PdfStructureCode = 'pdf_structure' | 'post_seal_revision' | 'duplicate_object' | 'xref_mismatch';

export class PdfStructureError extends Error {
  constructor(
    message: string,
    readonly code: PdfStructureCode,
  ) {
    super(message);
    this.name = 'PdfStructureError';
  }
}

/** Where pdf-lib's parse found an object's definition. */
type Definition =
  | { kind: 'top'; gen: number; offset: number }
  | { kind: 'objstm'; stream: number; index: number };

interface XRefEntry {
  ref: PDFRef;
  offset: number;
  deleted: boolean;
  inObjectStream: boolean;
}

/** The pdf-lib 1.17 parser internals this check instruments, per instance. */
interface ParserInternals {
  bytes: { offset(): number };
  context: PDFContext;
  parseDocument(): Promise<PDFContext>;
  parseIndirectObject(): Promise<PDFRef>;
  parseObject(): PDFObject;
  parseDict(): PDFDict;
  skipWhitespaceAndComments(): void;
  maybeParseCrossRefSection(): { subsections: XRefEntry[][] } | undefined;
  maybeParseTrailerDict(): void;
  maybeParseTrailer(): { lastXRefOffset: string } | undefined;
}

interface ParsedLayout {
  definitions: Map<number, Definition>;
  duplicates: number[];
  xrefStreams: { ref: PDFRef; offset: number; stream: PDFRawStream }[];
  classicSections: { offset: number; entries: XRefEntry[] }[];
  trailerDicts: PDFDict[];
  startxrefs: number[];
  context: PDFContext;
}

const PDF_WHITESPACE = '[\\x00\\x09\\x0a\\x0c\\x0d\\x20]';
const TAIL = new RegExp(`startxref${PDF_WHITESPACE}+(\\d+)${PDF_WHITESPACE}+%%EOF${PDF_WHITESPACE}*$`);

function fail(message: string, code: PdfStructureCode): never {
  throw new PdfStructureError(message, code);
}

/** Parse with pdf-lib exactly as `PDFDocument.load` does, recording where every object came from. */
async function parseLayout(bytes: Uint8Array): Promise<ParsedLayout> {
  // throwOnInvalidObject: a definition pdf-lib can only "recover" is refused,
  // not guessed at differently from a viewer.
  const parser = PDFParser.forBytesWithOptions(bytes, Infinity, true) as unknown as ParserInternals;
  const context = parser.context;
  const layout: ParsedLayout = {
    definitions: new Map(),
    duplicates: [],
    xrefStreams: [],
    classicSections: [],
    trailerDicts: [],
    startxrefs: [],
    context,
  };
  const define = (objectNumber: number, def: Definition): void => {
    if (layout.definitions.has(objectNumber) || objectNumber === 0) layout.duplicates.push(objectNumber);
    else layout.definitions.set(objectNumber, def);
  };

  let assigned: PDFRef[] | undefined;
  const assign = context.assign.bind(context);
  context.assign = (ref: PDFRef, object: PDFObject): void => {
    assigned?.push(ref);
    assign(ref, object);
  };

  let depth = 0;
  const top: { object?: PDFObject } = {};
  const parseObject = parser.parseObject.bind(parser);
  parser.parseObject = (): PDFObject => {
    depth += 1;
    try {
      const object = parseObject();
      if (depth === 1) top.object = object;
      return object;
    } finally {
      depth -= 1;
    }
  };

  const parseIndirectObject = parser.parseIndirectObject.bind(parser);
  parser.parseIndirectObject = async (): Promise<PDFRef> => {
    const offset = parser.bytes.offset();
    assigned = [];
    top.object = undefined;
    const ref = await parseIndirectObject();
    const inner = assigned;
    assigned = undefined;
    define(ref.objectNumber, { kind: 'top', gen: ref.generationNumber, offset });
    const topLevel = top.object as PDFObject | undefined;
    const type = topLevel instanceof PDFRawStream ? topLevel.dict.lookup(PDFName.of('Type')) : undefined;
    if (type === PDFName.of('ObjStm')) {
      inner.forEach((innerRef, index) => define(innerRef.objectNumber, { kind: 'objstm', stream: ref.objectNumber, index }));
    } else if (type === PDFName.of('XRef')) {
      layout.xrefStreams.push({ ref, offset, stream: topLevel as PDFRawStream });
    }
    return ref;
  };

  const maybeParseCrossRefSection = parser.maybeParseCrossRefSection.bind(parser);
  parser.maybeParseCrossRefSection = () => {
    parser.skipWhitespaceAndComments();
    const offset = parser.bytes.offset();
    const section = maybeParseCrossRefSection();
    if (section) layout.classicSections.push({ offset, entries: section.subsections.flat() });
    return section;
  };

  const parseDict = parser.parseDict.bind(parser);
  let lastDict: PDFDict | undefined;
  parser.parseDict = (): PDFDict => (lastDict = parseDict());
  const maybeParseTrailerDict = parser.maybeParseTrailerDict.bind(parser);
  parser.maybeParseTrailerDict = (): void => {
    const before = context.trailerInfo;
    lastDict = undefined;
    maybeParseTrailerDict();
    if (context.trailerInfo !== before && lastDict) layout.trailerDicts.push(lastDict);
  };

  const maybeParseTrailer = parser.maybeParseTrailer.bind(parser);
  parser.maybeParseTrailer = () => {
    const trailer = maybeParseTrailer();
    if (trailer) layout.startxrefs.push(Number(trailer.lastXRefOffset));
    return trailer;
  };

  await parser.parseDocument();
  return layout;
}

function xrefEntries(layout: ParsedLayout): { entries: XRefEntry[]; dict: PDFDict; offset: number } {
  const [stream] = layout.xrefStreams;
  if (stream) {
    const parser = PDFXRefStreamParser.forStream(stream.stream) as unknown as { parseEntries(): XRefEntry[] };
    return { entries: parser.parseEntries(), dict: stream.stream.dict, offset: stream.offset };
  }
  const [section] = layout.classicSections;
  const [trailer] = layout.trailerDicts;
  if (!section || !trailer) fail('The file has no cross-reference table and trailer.', 'pdf_structure');
  return { entries: section.entries, dict: trailer, offset: section.offset };
}

/**
 * Throws `PdfStructureError` unless `bytes` is a single-revision PDF whose
 * cross-reference data resolves every object to the one pdf-lib parsed.
 */
export async function checkPdfStructure(bytes: Uint8Array): Promise<void> {
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    fail('The file does not start with a PDF header.', 'pdf_structure');
  }

  // The parse decodes object and xref streams, so it shares the decode
  // limits. pdf-lib turns a limit hit inside an object into an "invalid
  // object", so the parse error is held until the budget has had its say.
  const parsed = await withPdfDecodeBudget(async () => {
    try {
      return { layout: await parseLayout(bytes) };
    } catch (err) {
      if (err instanceof PdfDecodeLimitError) throw err;
      return { error: err };
    }
  });
  if (!parsed.layout) {
    const detail = parsed.error instanceof Error ? parsed.error.message : String(parsed.error);
    fail(`The file is not a well-formed PDF (${detail}).`, 'pdf_structure');
  }
  const layout = parsed.layout;

  // 1. One revision: one xref section, one startxref, nothing after %%EOF.
  const tail = TAIL.exec(Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1'));
  if (!tail) {
    fail('The file has data after its final %%EOF, or does not end with startxref/%%EOF; it was modified after sealing.', 'post_seal_revision');
  }
  const sections = layout.xrefStreams.length + layout.classicSections.length;
  if (sections > 1 || layout.startxrefs.length > 1 || (layout.xrefStreams.length > 0 && layout.trailerDicts.length > 0) || layout.trailerDicts.length > 1) {
    fail(
      `The file has ${Math.max(sections, layout.startxrefs.length)} revisions (incremental updates after the seal); a sealed PDF has exactly one.`,
      'post_seal_revision',
    );
  }
  if (sections === 0 || layout.startxrefs.length === 0) {
    fail('The file has no cross-reference section.', 'pdf_structure');
  }

  // 2. One definition per object number.
  if (layout.duplicates.length > 0) {
    const numbers = [...new Set(layout.duplicates)].slice(0, 5).join(', ');
    fail(`Object number(s) ${numbers} are defined more than once; readers would not agree on which copy is the document.`, 'duplicate_object');
  }

  const xref = xrefEntries(layout);
  if (xref.dict.has(PDFName.of('Prev')) || xref.dict.has(PDFName.of('XRefStm'))) {
    fail('The cross-reference section links to another (/Prev or /XRefStm); a sealed PDF has exactly one revision.', 'post_seal_revision');
  }
  const startxref = layout.startxrefs[0]!;
  if (startxref !== Number(tail[1]) || startxref !== xref.offset) {
    fail(`startxref (${startxref}) does not point at the cross-reference section (offset ${xref.offset}).`, 'xref_mismatch');
  }
  const root = xref.dict.get(PDFName.of('Root'));
  if (!(root instanceof PDFRef) || layout.context.trailerInfo.Root !== root) {
    fail('The trailer /Root is not the catalog pdf-lib resolves.', 'xref_mismatch');
  }

  // 3. The xref resolves every object to exactly the definition pdf-lib holds,
  //    and lists every object pdf-lib holds.
  const listed = new Set<number>();
  for (const entry of xref.entries) {
    const n = entry.ref.objectNumber;
    if (listed.has(n)) fail(`The cross-reference table lists object ${n} more than once.`, 'xref_mismatch');
    listed.add(n);
    if (entry.deleted || n === 0) continue;
    const def = layout.definitions.get(n);
    const matches = def !== undefined && (entry.inObjectStream
      ? def.kind === 'objstm' && def.stream === entry.offset && def.index === entry.ref.generationNumber
      : def.kind === 'top' && def.offset === entry.offset && def.gen === entry.ref.generationNumber);
    if (!matches) {
      fail(
        def === undefined
          ? `The cross-reference table lists object ${n}, which the file does not define.`
          : `The cross-reference table resolves object ${n} somewhere other than its definition in the file.`,
        'xref_mismatch',
      );
    }
  }
  const resolved = new Set(xref.entries.filter((e) => !e.deleted).map((e) => e.ref.objectNumber));
  const xrefStreamNumber = layout.xrefStreams[0]?.ref.objectNumber;
  for (const n of layout.definitions.keys()) {
    if (resolved.has(n) || n === xrefStreamNumber) continue;
    fail(`Object ${n} is defined in the file but not resolved by the cross-reference table.`, 'xref_mismatch');
  }
}
