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
 * The sealer writes one revision with pdf-lib: header, objects, one classic
 * cross-reference table and trailer, `startxref`, `%%EOF` (no object
 * streams, since 2026-10-24; seals made before then put most objects in
 * object streams with one cross-reference stream instead). A pdf-lib
 * load/save round trip writes one of those two shapes. So this check refuses
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
 * Agreeing on WHICH bytes define each object is not enough: pdf-lib's lexer
 * also tolerates shapes that pdf.js reads differently, or refuses and then
 * repairs by indexing every `N G obj` in the raw bytes (where an object
 * hidden in an unreferenced stream's data can win). The sealer only ever
 * writes pdf-lib's own shapes, so these are refused too:
 *
 *   stream_framing        a stream whose data is not exactly `stream` CRLF or
 *                         LF, a direct integer /Length of bytes, an optional
 *                         EOL, `endstream`, `endobj` (pdf.js starts the data
 *                         after the first EOL and trusts /Length; pdf-lib
 *                         starts it right after `stream` and falls back to
 *                         scanning for `endstream`), or a stream nested inside
 *                         another object
 *   xref_malformed        a cross-reference table or stream pdf.js would not
 *                         read as pdf-lib does, or would reject and repair: a
 *                         subsection count that is not the number of entries
 *                         that follow (pdf-lib ignores the count), an entry
 *                         that is not 20 bytes, an object 0 that is not
 *                         `0000000000 65535 f`, a /Size not above every listed
 *                         object, a /W or /Index that does not describe the
 *                         stream's decoded length exactly, an entry type
 *                         other than 0, 1 or 2; or a first object carrying
 *                         /Linearized (pdf.js then reads the xref after it)
 *   name_encoding         a name not spelled exactly as pdf-lib writes it,
 *                         e.g. a lower-case or needless `#xx` escape (pdf-lib
 *                         decodes only upper-case escapes, pdf.js decodes
 *                         both, so `/R#6fot` is `Root` to a viewer only), or a
 *                         dictionary that spells one key twice
 *   object_stream_layout  an object stream whose header is not /N plain
 *                         number pairs before /First, whose offsets do not
 *                         strictly increase, or whose objects run past the
 *                         next one's offset (pdf.js parses each object only
 *                         up to the next offset; pdf-lib reads on), or that
 *                         holds a stream
 *
 * When all of that holds, the object pdf-lib holds for every number is the
 * one a conforming reader fetches through the xref, read the same way, so
 * the digest and the rendered document are the same objects. Objects that
 * nothing references are not refused: pdf-lib leaves some in genuine seals,
 * and with the xref a viewer reads exactly as pdf-lib does, no viewer ever
 * falls back to reading them.
 *
 * This applies to every manifest and digest version: it hardens the
 * verifier, it is not part of the signed digest.
 */

import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFXRefStreamParser,
} from 'pdf-lib';
import { PdfDecodeLimitError, withPdfDecodeBudget } from '../pdf/decode-limits';
import { assertParseObjectCeiling, withParseObjectCeiling } from '../pdf/object-ceiling';
import { sealedMaxParseObjects } from '../pdf/page-tree';
import { PdfComplexityError } from '../pdf/seal-limits';

export type PdfStructureCode =
  | 'pdf_structure'
  | 'post_seal_revision'
  | 'duplicate_object'
  | 'xref_mismatch'
  | 'xref_malformed'
  | 'stream_framing'
  | 'name_encoding'
  | 'object_stream_layout';

/** Codes recorded while parsing (the first problem of each is reported). */
type ParseProblemCode = 'stream_framing' | 'name_encoding' | 'object_stream_layout';

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

/** pdf-lib 1.17's ByteStream: `slice` copies, `bytes` is the array it reads. */
interface ByteStreamInternals {
  bytes: Uint8Array;
  length: number;
  offset(): number;
  slice(start: number, end: number): Uint8Array;
}

/** The pdf-lib 1.17 object-parser internals this check instruments, per instance. */
interface ObjectParserInternals {
  bytes: ByteStreamInternals;
  context: PDFContext;
  parseObject(): PDFObject;
  parseDict(): PDFDict;
  parseDictOrStream(): PDFObject;
  parseName(): PDFName;
}

/** The pdf-lib 1.17 parser internals this check instruments, per instance. */
interface ParserInternals extends ObjectParserInternals {
  parseDocument(): Promise<PDFContext>;
  parseIndirectObject(): Promise<PDFRef>;
  skipWhitespaceAndComments(): void;
  maybeParseCrossRefSection(): { subsections: XRefEntry[][] } | undefined;
  maybeParseTrailerDict(): void;
  maybeParseTrailer(): { lastXRefOffset: string } | undefined;
}

type OffsetPair = { objectNumber: number; offset: number };

/** What pdf-lib's parser of one object stream read: the decoded data, its offset table, and where each member's parse began and ended. */
interface ObjectStreamRead {
  data: Uint8Array;
  pairs: OffsetPair[];
  members: { start: number; end: number }[];
  holdsStream: boolean;
}

interface ObjectStreamLayout extends ObjectStreamRead {
  stream: number;
  dict: PDFDict;
}

interface ParsedLayout {
  definitions: Map<number, Definition>;
  duplicates: number[];
  xrefStreams: { ref: PDFRef; offset: number; stream: PDFRawStream }[];
  classicSections: { offset: number; entries: XRefEntry[] }[];
  trailerDicts: PDFDict[];
  startxrefs: number[];
  objectStreams: ObjectStreamLayout[];
  /** The first top-level object in the file (pdf.js looks there for /Linearized). */
  firstObject?: PDFObject;
  problems: Map<ParseProblemCode, string>;
  context: PDFContext;
}

const PDF_WHITESPACE = '[\\x00\\x09\\x0a\\x0c\\x0d\\x20]';
const TAIL = new RegExp(`startxref${PDF_WHITESPACE}+(\\d+)${PDF_WHITESPACE}+%%EOF${PDF_WHITESPACE}*$`);
const CR = 0x0d;
const LF = 0x0a;

function fail(message: string, code: PdfStructureCode): never {
  throw new PdfStructureError(message, code);
}

function isPdfWhitespace(byte: number | undefined): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function matchesAt(bytes: Uint8Array, at: number, keyword: string): boolean {
  if (at < 0 || at + keyword.length > bytes.length) return false;
  for (let i = 0; i < keyword.length; i++) if (bytes[at + i] !== keyword.charCodeAt(i)) return false;
  return true;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, Math.max(0, end - start)).toString('latin1');
}

/** A name for a message: printable, and short. */
function shownName(raw: string): string {
  const shown = JSON.stringify(raw.length > 64 ? `${raw.slice(0, 64)}...` : raw);
  return shown.slice(1, -1);
}

/** A direct, non-negative integer. */
function directInteger(value: PDFObject | undefined): number | undefined {
  if (!(value instanceof PDFNumber)) return undefined;
  const n = value.asNumber();
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * `stream` then exactly CRLF or LF, then `/Length` bytes of data, an optional
 * EOL, `endstream`, whitespace and `endobj`: the one framing on which pdf.js
 * (data after the first EOL, length from /Length) and pdf-lib (data right
 * after `stream`, scanning for `endstream` when /Length does not land on it)
 * read the same bytes. Returns what is wrong, or undefined.
 */
function streamFramingProblem(bytes: Uint8Array, stream: PDFRawStream, start: number, end: number): string | undefined {
  const length = directInteger(stream.dict.get(PDFName.of('Length')));
  if (length === undefined) return 'its /Length is not a direct non-negative integer';
  if (end - start !== length) return `/Length is ${length} but its data runs ${end - start} bytes to endstream`;
  const eol = bytes[start - 1] === LF ? (bytes[start - 2] === CR ? 2 : 1) : 0;
  if (eol === 0 || !matchesAt(bytes, start - eol - 'stream'.length, 'stream')) {
    return 'the stream keyword is not followed by exactly CRLF or LF';
  }
  let at = end;
  if (bytes[at] === CR) at++;
  if (bytes[at] === LF) at++;
  if (!matchesAt(bytes, at, 'endstream')) return 'its data is not followed by an EOL and endstream';
  at += 'endstream'.length;
  while (isPdfWhitespace(bytes[at])) at++;
  if (!matchesAt(bytes, at, 'endobj')) return 'endstream is not followed by endobj';
  return undefined;
}

interface SyntaxWatch {
  /** Every object parsed at the top level of this parser (depth 1), with where its parse began and ended. */
  onTopObject?(object: PDFObject, start: number, end: number): void;
  /** Every stream parsed, with its data range in this parser's bytes. */
  onStream(stream: PDFRawStream, dataStart: number, dataEnd: number, depth: number): void;
  problem(code: ParseProblemCode, message: string): void;
}

/**
 * Instrument one pdf-lib parser instance (the file's, or an object
 * stream's): every name it reads must be spelled exactly as pdf-lib writes
 * that name (`asString()`: `#xx` with upper-case hex, only for characters
 * that need it), every dictionary must spell each key once, and each stream's
 * data range is reported.
 */
function watchObjectSyntax(parser: ObjectParserInternals, watch: SyntaxWatch): void {
  let depth = 0;
  const parseObject = parser.parseObject.bind(parser);
  parser.parseObject = (): PDFObject => {
    const start = parser.bytes.offset();
    depth += 1;
    try {
      const object = parseObject();
      if (depth === 1) watch.onTopObject?.(object, start, parser.bytes.offset());
      return object;
    } finally {
      depth -= 1;
    }
  };

  // Keys are read by parseDict itself, values through parseObject (one level deeper).
  const frames: { depth: number; keys: Set<PDFName> }[] = [];
  const parseDict = parser.parseDict.bind(parser);
  parser.parseDict = (): PDFDict => {
    frames.push({ depth, keys: new Set() });
    try {
      return parseDict();
    } finally {
      frames.pop();
    }
  };
  const parseName = parser.parseName.bind(parser);
  parser.parseName = (): PDFName => {
    const start = parser.bytes.offset();
    const name = parseName();
    const raw = latin1(parser.bytes.bytes, start, parser.bytes.offset());
    if (name.asString() !== raw) {
      watch.problem(
        'name_encoding',
        `The name ${shownName(raw)} is not written the way pdf-lib writes names (a lower-case or needless #xx escape); pdf-lib and viewers can read it as different names.`,
      );
    }
    const frame = frames[frames.length - 1];
    if (frame && frame.depth === depth) {
      if (frame.keys.has(name)) {
        watch.problem('name_encoding', `A dictionary lists the key ${shownName(name.asString())} more than once; readers need not keep the same value.`);
      }
      frame.keys.add(name);
    }
    return name;
  };

  // parseDictOrStream reads a stream's data with exactly one bytes.slice(start, end).
  let lastSlice: [number, number] | undefined;
  const bytes = parser.bytes;
  const slice = bytes.slice.bind(bytes);
  bytes.slice = (start: number, end: number): Uint8Array => {
    lastSlice = [start, end];
    return slice(start, end);
  };
  const parseDictOrStream = parser.parseDictOrStream.bind(parser);
  parser.parseDictOrStream = (): PDFObject => {
    lastSlice = undefined;
    const object = parseDictOrStream();
    if (object instanceof PDFRawStream && lastSlice) watch.onStream(object, lastSlice[0], lastSlice[1], depth);
    return object;
  };
}

// The object-stream parser is built inside pdf-lib's parseIndirectObject, so
// it is reached through its prototype: each layout parse registers its
// context, and the parser of an object stream in that context is
// instrumented once its offset table is read. Shared through globalThis, as
// in object-ceiling.ts, so that a second copy of this module still sees the
// one installed hook.
type ObjectStreamWatcher = (parser: ObjectParserInternals, pairs: OffsetPair[]) => void;
const OBJECT_STREAM_WATCHERS = Symbol.for('docuridge.pdfObjectStreamWatchers');
const objectStreamWatchers: WeakMap<PDFContext, ObjectStreamWatcher> = ((globalThis as Record<symbol, unknown>)[
  OBJECT_STREAM_WATCHERS
] ??= new WeakMap<PDFContext, ObjectStreamWatcher>()) as WeakMap<PDFContext, ObjectStreamWatcher>;
const WATCHED = Symbol.for('docuridge.pdfObjectStreamWatch');

function installObjectStreamWatch(): void {
  const proto = PDFObjectStreamParser.prototype as unknown as Record<PropertyKey, unknown>;
  if (typeof proto.parseOffsetsAndObjectNumbers !== 'function') {
    throw new Error('pdf-lib PDFObjectStreamParser.parseOffsetsAndObjectNumbers not found; object streams cannot be checked');
  }
  if (proto[WATCHED]) return;
  const original = proto.parseOffsetsAndObjectNumbers as (this: ObjectParserInternals) => OffsetPair[];
  proto.parseOffsetsAndObjectNumbers = function watchedParseOffsets(this: ObjectParserInternals): OffsetPair[] {
    const pairs = original.call(this);
    objectStreamWatchers.get(this.context)?.(this, pairs);
    return pairs;
  };
  proto[WATCHED] = true;
}

installObjectStreamWatch();

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
    objectStreams: [],
    problems: new Map(),
    context,
  };
  const problem = (code: ParseProblemCode, message: string): void => {
    if (!layout.problems.has(code)) layout.problems.set(code, message);
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

  // The indirect object being parsed, if any: its body, its stream's
  // framing, and (for an object stream) what that stream's parser read.
  let current: { object?: PDFObject; framing?: string; objectStream?: ObjectStreamRead } | undefined;
  let first = true;
  watchObjectSyntax(parser, {
    onTopObject: (object) => {
      if (current) current.object = object;
    },
    onStream: (stream, start, end, depth) => {
      if (!current || depth !== 1) {
        problem('stream_framing', 'A stream is nested inside another object; only an indirect object may be a stream.');
        return;
      }
      current.framing = streamFramingProblem(bytes, stream, start, end);
    },
    problem,
  });

  objectStreamWatchers.set(context, (stmParser, pairs) => {
    const objectStream: ObjectStreamRead = { data: stmParser.bytes.bytes, pairs, members: [], holdsStream: false };
    if (current) current.objectStream = objectStream;
    watchObjectSyntax(stmParser, {
      onTopObject: (_object, start, end) => objectStream.members.push({ start, end }),
      onStream: () => {
        objectStream.holdsStream = true;
      },
      problem,
    });
  });

  const parseIndirectObject = parser.parseIndirectObject.bind(parser);
  parser.parseIndirectObject = async (): Promise<PDFRef> => {
    const offset = parser.bytes.offset();
    assigned = [];
    const record: { object?: PDFObject; framing?: string; objectStream?: ObjectStreamRead } = {};
    current = record;
    let ref: PDFRef;
    try {
      ref = await parseIndirectObject();
    } finally {
      current = undefined;
    }
    const inner = assigned;
    assigned = undefined;
    define(ref.objectNumber, { kind: 'top', gen: ref.generationNumber, offset });
    if (first) layout.firstObject = record.object;
    first = false;
    if (record.framing) {
      problem(
        'stream_framing',
        `The stream in object ${ref.objectNumber} is not framed as pdf-lib writes streams (${record.framing}); viewers would read different bytes than the digest covers.`,
      );
    }
    const topLevel = record.object;
    const type = topLevel instanceof PDFRawStream ? topLevel.dict.lookup(PDFName.of('Type')) : undefined;
    if (type === PDFName.of('ObjStm')) {
      inner.forEach((innerRef, index) => define(innerRef.objectNumber, { kind: 'objstm', stream: ref.objectNumber, index }));
      if (record.objectStream) {
        layout.objectStreams.push({ ...record.objectStream, stream: ref.objectNumber, dict: (topLevel as PDFRawStream).dict });
      }
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

  try {
    await parser.parseDocument();
  } finally {
    objectStreamWatchers.delete(context);
  }
  return layout;
}

interface XRefSection {
  entries: XRefEntry[];
  dict: PDFDict;
  offset: number;
  /** An xref stream's decoded data (undefined for a classic table). */
  streamData?: Uint8Array;
}

function xrefEntries(layout: ParsedLayout): XRefSection {
  const [stream] = layout.xrefStreams;
  if (stream) {
    const parser = PDFXRefStreamParser.forStream(stream.stream) as unknown as { bytes: ByteStreamInternals; parseEntries(): XRefEntry[] };
    return { entries: parser.parseEntries(), dict: stream.stream.dict, offset: stream.offset, streamData: parser.bytes.bytes };
  }
  const [section] = layout.classicSections;
  const [trailer] = layout.trailerDicts;
  if (!section || !trailer) fail('The file has no cross-reference table and trailer.', 'pdf_structure');
  return { entries: section.entries, dict: trailer, offset: section.offset };
}

/**
 * A classic table as pdf-lib writes it: `xref`, then subsections of a
 * `<first> <count>` line followed by exactly `count` 20-byte entries, then
 * `trailer`, starting at object 0. pdf-lib ignores the counts (it numbers
 * entries on from each header); pdf.js uses them, so a count that does not
 * match makes it reject the table and rebuild one from the raw bytes.
 * Returns what is wrong, or undefined.
 */
function classicXrefProblem(bytes: Uint8Array, offset: number, entries: XRefEntry[]): string | undefined {
  let at = offset;
  if (!matchesAt(bytes, at, 'xref')) return 'it does not start with the xref keyword';
  at += 'xref'.length;
  const eol = bytes[at] === CR ? (bytes[at + 1] === LF ? 2 : 1) : bytes[at] === LF ? 1 : 0;
  if (eol === 0) return 'the xref keyword is not on a line of its own';
  at += eol;
  const read: { num: number; gen: number; offset: number; free: boolean }[] = [];
  for (;;) {
    while (isPdfWhitespace(bytes[at])) at++;
    if (matchesAt(bytes, at, 'trailer')) break;
    const header = /^(\d{1,10}) (\d{1,10})(?:\r\n|\n|\r)/.exec(latin1(bytes, at, Math.min(bytes.length, at + 24)));
    if (!header) return 'a subsection header is not "<first object> <count>" on a line of its own, or a subsection holds more entries than its count';
    at += header[0].length;
    const first = Number(header[1]);
    const count = Number(header[2]);
    if (read.length === 0 && first !== 0) return `the first subsection starts at object ${first}, not 0`;
    for (let i = 0; i < count; i++) {
      const entry = /^(\d{10}) (\d{5}) ([fn])(?: \r| \n|\r\n)$/.exec(latin1(bytes, at, Math.min(bytes.length, at + 20)));
      if (!entry) return `subsection "${first} ${count}" is not followed by ${count} 20-byte entries`;
      read.push({ num: first + i, offset: Number(entry[1]), gen: Number(entry[2]), free: entry[3] === 'f' });
      at += 20;
    }
  }
  const same = read.length === entries.length && read.every((e, i) => {
    const parsed = entries[i]!;
    return parsed.ref.objectNumber === e.num && parsed.ref.generationNumber === e.gen && parsed.offset === e.offset && parsed.deleted === e.free;
  });
  return same ? undefined : 'pdf-lib numbers its entries differently from the subsection headers';
}

/**
 * An xref stream pdf.js reads entry for entry as pdf-lib does: a direct /W
 * of three widths, /Index absent or direct first/count pairs, a direct
 * /Size, entries filling the decoded data exactly (pdf-lib reads missing
 * bytes as zeros, pdf.js rejects the stream), and every type 0, 1 or 2
 * (pdf-lib treats any other as in use, pdf.js rejects it). Returns what is
 * wrong, or undefined.
 */
function xrefStreamProblem(dict: PDFDict, data: Uint8Array): string | undefined {
  const w = dict.get(PDFName.of('W'));
  const widths = w instanceof PDFArray && w.size() === 3 ? w.asArray().map(directInteger) : [];
  if (widths.length !== 3 || widths.some((x) => x === undefined)) return '/W is not a direct array of three non-negative integers';
  const [typeWidth, offsetWidth, genWidth] = widths as [number, number, number];
  const size = directInteger(dict.get(PDFName.of('Size')));
  if (size === undefined) return '/Size is not a direct non-negative integer';
  const index = dict.get(PDFName.of('Index'));
  const ranges = index === undefined ? [0, size] : index instanceof PDFArray ? index.asArray().map(directInteger) : [];
  if (ranges.length === 0 || ranges.length % 2 !== 0 || ranges.some((x) => x === undefined)) {
    return '/Index is not a direct array of first/count integer pairs';
  }
  let count = 0;
  for (let i = 1; i < ranges.length; i += 2) count += ranges[i]!;
  const entryWidth = typeWidth + offsetWidth + genWidth;
  if (count * entryWidth !== data.length) {
    return `/W and /Index describe ${count * entryWidth} bytes of entries but the stream holds ${data.length}`;
  }
  for (let i = 0; i < count && typeWidth > 0; i++) {
    let type = 0;
    for (let j = 0; j < typeWidth; j++) type = type * 256 + data[i * entryWidth + j]!;
    if (type > 2) return `an entry has type ${type}`;
  }
  return undefined;
}

/**
 * The shape both readers agree on, for either kind of section: object 0 is
 * the free-list head (`0 65535 f`, as pdf-lib writes it), /Size is a direct
 * integer above every listed object, and the first object in the file is not
 * a linearization dictionary (pdf.js would then read the cross-reference
 * data that follows that object instead of this section).
 */
function xrefShapeProblem(bytes: Uint8Array, layout: ParsedLayout, xref: XRefSection): string | undefined {
  const problem = xref.streamData
    ? xrefStreamProblem(xref.dict, xref.streamData)
    : classicXrefProblem(bytes, xref.offset, xref.entries);
  if (problem) return problem;
  const zero = xref.entries.find((e) => e.ref.objectNumber === 0);
  if (!zero || !zero.deleted || zero.ref.generationNumber !== 65535 || zero.offset !== 0) {
    return 'object 0 is not listed as the free-list head (0 65535 f)';
  }
  const size = directInteger(xref.dict.get(PDFName.of('Size')));
  const highest = xref.entries.reduce((max, e) => Math.max(max, e.ref.objectNumber), 0);
  if (size === undefined || size <= highest) return `/Size (${xref.dict.get(PDFName.of('Size')) ?? 'missing'}) is not above every listed object (up to ${highest})`;
  const first = layout.firstObject instanceof PDFRawStream ? layout.firstObject.dict : layout.firstObject;
  if (first instanceof PDFDict && first.has(PDFName.of('Linearized'))) {
    return 'the first object is a linearization dictionary, which points viewers at other cross-reference data';
  }
  return undefined;
}

/**
 * An object stream pdf.js reads as pdf-lib does: a direct /N and /First, a
 * header of exactly /N plain object-number/offset pairs before /First,
 * offsets that strictly increase, and each object ending at or before the
 * next one's offset (pdf.js parses object i only within
 * [First + offset_i, First + offset_{i+1}); pdf-lib reads on). No member
 * may be a stream. Returns what is wrong, or undefined.
 */
function objectStreamProblem(objectStream: ObjectStreamLayout): string | undefined {
  if (objectStream.holdsStream) return 'it holds a stream';
  const { data, pairs, members } = objectStream;
  const n = directInteger(objectStream.dict.get(PDFName.of('N')));
  const first = directInteger(objectStream.dict.get(PDFName.of('First')));
  if (n === undefined || first === undefined) return '/N or /First is not a direct non-negative integer';
  if (first > data.length) return '/First lies past the end of its data';
  const tokens = latin1(data, 0, first).split(new RegExp(`${PDF_WHITESPACE}+`)).filter((t) => t !== '');
  const header = tokens.every((t) => /^\d+$/.test(t)) && tokens.length === 2 * n && pairs.length === n &&
    pairs.every((p, i) => Number(tokens[2 * i]) === p.objectNumber && Number(tokens[2 * i + 1]) === p.offset);
  if (!header) return `its header before /First is not ${n} object-number/offset pairs`;
  if (members.length !== n) return 'pdf-lib did not read one object per header pair';
  for (let i = 1; i < n; i++) {
    if (pairs[i]!.offset <= pairs[i - 1]!.offset) return 'its offsets do not strictly increase';
    if (members[i - 1]!.end > first + pairs[i]!.offset) {
      return `object ${pairs[i - 1]!.objectNumber} runs past the offset of the next object`;
    }
  }
  return undefined;
}

/**
 * Throws `PdfStructureError` unless `bytes` is a single-revision PDF whose
 * cross-reference data resolves every object to the one pdf-lib parsed.
 *
 * The parse runs under the parse-object ceiling for sealed PDFs
 * (`maxParseObjects`, default `sealedMaxParseObjects()`): a byte scan before
 * parsing and an exact count during it. Past it, rejects with
 * `PdfComplexityError('parse_objects')`; past a decode limit, with
 * `PdfDecodeLimitError`.
 */
export async function checkPdfStructure(
  bytes: Uint8Array,
  options: { maxParseObjects?: number } = {},
): Promise<void> {
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    fail('The file does not start with a PDF header.', 'pdf_structure');
  }
  const maxObjects = options.maxParseObjects ?? sealedMaxParseObjects();
  assertParseObjectCeiling(bytes, maxObjects);

  // The parse decodes object and xref streams, so it shares the decode
  // limits. pdf-lib turns a limit hit inside an object into an "invalid
  // object", so the parse error is held until the budget has had its say.
  const parsed = await withPdfDecodeBudget(async () => {
    try {
      return { layout: await withParseObjectCeiling(() => parseLayout(bytes), maxObjects) };
    } catch (err) {
      if (err instanceof PdfDecodeLimitError || err instanceof PdfComplexityError) throw err;
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

  // 3. Every object is written in a shape pdf.js reads as pdf-lib does.
  for (const code of ['stream_framing', 'name_encoding', 'object_stream_layout'] as const) {
    const message = layout.problems.get(code);
    if (message) fail(message, code);
  }
  for (const objectStream of layout.objectStreams) {
    const problem = objectStreamProblem(objectStream);
    if (problem) {
      fail(`Object stream ${objectStream.stream} is not laid out as pdf-lib writes one (${problem}); viewers would read different objects from it.`, 'object_stream_layout');
    }
  }

  const xref = xrefEntries(layout);
  if (xref.dict.has(PDFName.of('Prev')) || xref.dict.has(PDFName.of('XRefStm'))) {
    fail('The cross-reference section links to another (/Prev or /XRefStm); a sealed PDF has exactly one revision.', 'post_seal_revision');
  }
  const startxref = layout.startxrefs[0]!;
  if (startxref !== Number(tail[1]) || startxref !== xref.offset) {
    fail(`startxref (${startxref}) does not point at the cross-reference section (offset ${xref.offset}).`, 'xref_mismatch');
  }
  const shape = xrefShapeProblem(bytes, layout, xref);
  if (shape) {
    fail(`The cross-reference section is not one pdf.js reads as pdf-lib does (${shape}); a viewer would rebuild it from the raw bytes.`, 'xref_malformed');
  }
  const root = xref.dict.get(PDFName.of('Root'));
  if (!(root instanceof PDFRef) || layout.context.trailerInfo.Root !== root) {
    fail('The trailer /Root is not the catalog pdf-lib resolves.', 'xref_mismatch');
  }

  // 4. The xref resolves every object to exactly the definition pdf-lib holds,
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
