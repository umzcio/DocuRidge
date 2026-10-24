/**
 * Ceiling on how many objects pdf-lib may register while parsing a PDF.
 *
 * `PDFDocument.load` builds one object per top-level definition and per
 * object-stream member, and every registered object grows pdf-lib's
 * module-global PDFRef/PDFName intern pools. A small file declaring millions
 * of tiny objects can therefore exhaust memory inside the parser. Two checks
 * enforce `PDF_MAX_PARSE_OBJECTS`:
 *
 *   1. `assertParseObjectCeiling`: a cheap byte scan, before parsing, that
 *      bounds TOP-LEVEL definitions only. It does not look inside object
 *      streams.
 *   2. `withParseObjectCeiling`: an exact count during parsing. Every object
 *      pdf-lib registers goes through `PDFContext.prototype.assign` (top-level
 *      definitions, object-stream members, recovered invalid objects), so that
 *      one method is wrapped. Inside a scope, each call increments a counter;
 *      past the ceiling it throws `PdfComplexityError('parse_objects')`, and
 *      keeps throwing on every later call so the parser unwinds instead of
 *      carrying on. pdf-lib catches errors from individual objects, so the
 *      scope remembers the error and rethrows it when the work finishes.
 *      An object stream's offset table (`/N` number pairs) is parsed in full
 *      before its first member is assigned, so inside a scope
 *      `PDFObjectStreamParser.prototype.parseOffsetsAndObjectNumbers` is
 *      guarded too: a stream whose `/N` (as pdf-lib itself resolved it)
 *      would take the count past the ceiling is refused before any pair is
 *      read.
 *      Outside a scope (e.g. `PDFDocument.create()` and seal-time building)
 *      the wrapper does nothing.
 *
 * Reads its cap from `process.env` so it also works in scripts and tests.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { PDFContext, PDFObjectStreamParser } from 'pdf-lib';
import { PdfComplexityError } from './seal-limits';

/** Default ceiling on objects registered while parsing one PDF. */
export const DEFAULT_PDF_MAX_PARSE_OBJECTS = 1_000_000;

export function getParseObjectCeiling(): number {
  const raw = typeof process === 'undefined' ? undefined : process.env?.PDF_MAX_PARSE_OBJECTS;
  if (!raw) return DEFAULT_PDF_MAX_PARSE_OBJECTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PDF_MAX_PARSE_OBJECTS;
}

const OBJ_KEYWORD = /(?<!end)obj/g;

/**
 * An OVER-estimate of the TOP-LEVEL object definitions in `bytes`: every
 * occurrence of `obj` that is not the tail of `endobj`, after `#xx` escapes
 * are decoded. Each real definition contains that keyword, so no separator,
 * comment or glueing hides one; `obj` inside strings, comments or stream data
 * over-counts, which is acceptable.
 *
 * It does NOT count object-stream members. Those are counted exactly while
 * parsing, by `withParseObjectCeiling`.
 */
export function countDeclaredObjects(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString('latin1')
    .replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  let count = 0;
  for (const _ of text.matchAll(OBJ_KEYWORD)) count++;
  return count;
}

function ceilingError(max: number): PdfComplexityError {
  return new PdfComplexityError('parse_objects', `The PDF declares more than ${max} objects`);
}

/** Pre-parse check: refuses a file whose top-level definitions alone exceed `max`. */
export function assertParseObjectCeiling(bytes: Uint8Array, max: number = getParseObjectCeiling()): void {
  if (countDeclaredObjects(bytes) > max) throw ceilingError(max);
}

interface ParseCounter {
  max: number;
  count: number;
  error?: PdfComplexityError;
}

// Shared through globalThis: if a bundler instantiates this module twice
// against one pdf-lib, the single installed guard must still see every scope.
const COUNTERS = Symbol.for('docuridge.pdfParseObjectCounters');
const counters: AsyncLocalStorage<ParseCounter> = ((globalThis as Record<symbol, unknown>)[COUNTERS] ??=
  new AsyncLocalStorage<ParseCounter>()) as AsyncLocalStorage<ParseCounter>;
const GUARDED = Symbol.for('docuridge.pdfParseObjectGuard');

type Assign = (this: PDFContext, ...args: Parameters<PDFContext['assign']>) => void;
type ObjectStreamParserLike = { objectCount?: unknown };
type ParseOffsets = (this: ObjectStreamParserLike) => unknown;

function refuse(counter: ParseCounter): never {
  counter.error ??= ceilingError(counter.max);
  throw counter.error;
}

function installParseObjectGuard(): void {
  const proto = PDFContext.prototype as unknown as Record<PropertyKey, unknown>;
  const streamProto = PDFObjectStreamParser.prototype as unknown as Record<PropertyKey, unknown>;
  if (typeof proto.assign !== 'function' || typeof streamProto.parseOffsetsAndObjectNumbers !== 'function') {
    throw new Error('pdf-lib PDFContext.assign or PDFObjectStreamParser.parseOffsetsAndObjectNumbers not found; the PDF parse-object ceiling cannot be enforced');
  }
  if (proto[GUARDED]) return;
  const original = proto.assign as Assign;
  const originalParseOffsets = streamProto.parseOffsetsAndObjectNumbers as ParseOffsets;

  // objectCount is set in the parser's constructor from
  // dict.lookup(/N, PDFNumber), so the spelling of /N in the file is irrelevant.
  streamProto.parseOffsetsAndObjectNumbers = function guardedParseOffsets(this: ObjectStreamParserLike): unknown {
    const counter = counters.getStore();
    if (counter) {
      if (counter.error) throw counter.error;
      const declared = typeof this.objectCount === 'number' ? this.objectCount : Number.POSITIVE_INFINITY;
      if (!(counter.count + declared <= counter.max)) refuse(counter);
    }
    return originalParseOffsets.call(this);
  };

  proto.assign = function guardedAssign(this: PDFContext, ...args: Parameters<PDFContext['assign']>): void {
    const counter = counters.getStore();
    if (counter) {
      if (counter.error) throw counter.error;
      counter.count += 1;
      if (counter.count > counter.max) refuse(counter);
    }
    return original.apply(this, args);
  };
  proto[GUARDED] = true;
}

installParseObjectGuard();

/**
 * Run `fn` (a `PDFDocument.load`) counting every object pdf-lib registers in
 * it. Rejects with `PdfComplexityError('parse_objects')` once more than `max`
 * are registered, even when pdf-lib caught that error and carried on.
 */
export async function withParseObjectCeiling<T>(
  fn: () => Promise<T>,
  max: number = getParseObjectCeiling(),
): Promise<T> {
  const counter: ParseCounter = { max, count: 0 };
  let result: T;
  try {
    result = await counters.run(counter, fn);
  } catch (err) {
    throw counter.error ?? err;
  }
  if (counter.error) throw counter.error;
  return result;
}
