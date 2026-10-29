/**
 * Refusals for source content the canonical file cannot reproduce.
 *
 * Canonicalization rewrites an upload into the seal's own page layout, so
 * whatever a viewer would add on top of the page content at display time
 * (redrawn form fields, annotation appearances pdf.js makes up, optional-
 * content layers switched off) has to be refused rather than silently lost or
 * shown differently to the signer than to the seal.
 *
 * Worker-side: pdf-lib only. No prisma, env, crypto, audit or logger imports,
 * and no file reads.
 */

import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument, type PDFObject } from 'pdf-lib';
import { PdfComplexityError, getPdfSealLimits } from './seal-limits';

export type SourcePolicyReason = 'need_appearances' | 'visible_annotations' | 'hidden_layers';

const MESSAGES: Record<SourcePolicyReason, string> = {
  need_appearances: 'The PDF form asks the viewer to redraw its fields',
  visible_annotations: 'The PDF has annotations the signed copy would not show',
  hidden_layers: 'The PDF has optional-content layers that are switched off or conditional',
};

/** The source holds content the canonical file cannot reproduce. */
export class SourcePolicyError extends Error {
  /** Also the serialized `code`, so the reason survives the worker IPC. */
  readonly code: SourcePolicyReason;
  constructor(readonly reason: SourcePolicyReason) {
    super(MESSAGES[reason]);
    this.name = 'SourcePolicyError';
    this.code = reason;
  }
}

export function isSourcePolicyReason(value: unknown): value is SourcePolicyReason {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES, value);
}

const FLAG_HIDDEN = 1 << 1;
const FLAG_NOVIEW = 1 << 5;

function isPlainDict(value: unknown): value is PDFDict {
  return value instanceof PDFDict && !(value instanceof PDFStream);
}

/**
 * Refuse a form that sets /NeedAppearances true: viewers regenerate the
 * fields' appearances from /V, which can differ from the stored /AP the
 * flattener would draw. A document with no fields is unaffected. Call before
 * the form is flattened.
 */
export function assertNoNeedAppearances(doc: PDFDocument): void {
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (!isPlainDict(acroForm)) return;
  if (acroForm.lookup(PDFName.of('NeedAppearances')) !== PDFBool.True) return;
  const fields = acroForm.lookup(PDFName.of('Fields'));
  if (fields instanceof PDFArray && fields.size() > 0) throw new SourcePolicyError('need_appearances');
}

/** True when `/AP /N` is a stream, or a dictionary with at least one state. */
function hasNormalAppearance(annot: PDFDict): boolean {
  const ap = annot.lookup(PDFName.of('AP'));
  if (!isPlainDict(ap)) return false;
  const normal = ap.lookup(PDFName.of('N'));
  if (normal instanceof PDFStream) return true;
  return isPlainDict(normal) && normal.keys().length > 0;
}

/**
 * Refuse any annotation still on a page that the seal would not draw:
 * everything except Hidden or NoView annotations, and Link or Popup
 * annotations with no normal appearance. Call after the form is flattened, so
 * in-tree widgets are gone and a widget left over is an orphan. Annotations
 * scanned count against `maxAnnotations`.
 */
export function assertNoVisibleAnnotations(_doc: PDFDocument, leaves: PDFDict[]): void {
  const limit = getPdfSealLimits().maxAnnotations;
  let scanned = 0;
  const SUBTYPE = PDFName.of('Subtype');
  for (const leaf of leaves) {
    const annots = leaf.lookup(PDFName.of('Annots'));
    if (annots === undefined) continue;
    if (!(annots instanceof PDFArray)) throw new SourcePolicyError('visible_annotations');
    for (let i = 0, n = annots.size(); i < n; i++) {
      if (++scanned > limit) {
        throw new PdfComplexityError('annotations', `The PDF has more than ${limit} annotations`);
      }
      const annot = annots.lookup(i);
      if (!isPlainDict(annot)) throw new SourcePolicyError('visible_annotations');
      if ((annotationFlags(annot) & (FLAG_HIDDEN | FLAG_NOVIEW)) !== 0) continue;
      const subtype = annot.lookup(SUBTYPE);
      const inert = subtype === PDFName.of('Link') || subtype === PDFName.of('Popup');
      if (inert && !hasNormalAppearance(annot)) continue;
      throw new SourcePolicyError('visible_annotations');
    }
  }
}

/**
 * An annotation's flags as pdf.js reads them: a positive integer, else 0. A
 * negative or fractional /F is not "every bit set" or "truncated"; pdf.js
 * treats it as no flags at all, so the annotation is visible.
 */
export function annotationFlags(annot: PDFDict): number {
  const raw = annot.lookup(PDFName.of('F'));
  const f = raw instanceof PDFNumber ? raw.asNumber() : 0;
  return Number.isInteger(f) && f > 0 ? f : 0;
}

/** Nesting pdf.js accepts in a /VE visibility expression. */
const MAX_EXPRESSION_NESTING = 10;
/** Nesting of direct dictionaries and arrays the optional-content scan descends. */
const MAX_DIRECT_DEPTH = 256;

/**
 * Decide what to do with /OCProperties, as pdf.js 4.10 shows the file.
 * `'none'` when the file has none. `'all_on'` when every piece of optional
 * content is visible under the default configuration (the caller drops the
 * properties, which shows exactly that). Anything pdf.js would hide is
 * refused as `hidden_layers`:
 *
 * - the default configuration switches a group off: a non-empty /D /OFF, a
 *   /BaseState other than /ON, or a /D /AS (usage-driven state);
 * - a group whose /Usage /View /ViewState is /OFF (pdf.js hides it whatever
 *   /D /ON says), wherever it is in the file;
 * - an optional-content membership dictionary (OCMD) that evaluates hidden.
 *
 * Every OCMD in the file is found by walking every indirect object and the
 * direct dictionaries and arrays inside it, so page /Properties, XObject and
 * annotation /OC, tiling-pattern cells, Type3 glyph resources and soft-mask
 * groups are all covered in one pass.
 *
 * Which dictionary is what follows pdf.js 4.10, which decides an /OC target
 * (marked content, XObject or annotation; `parseMarkedContentProps`) by its
 * /Type, resolved: /OCG is a group, /OCMD a membership dictionary, anything
 * else no optional content at all. So here: every object listed in
 * /OCProperties /OCGs is a group whatever its /Type (pdf.js reads their
 * /Usage without looking at it), and so is a dictionary whose resolved /Type
 * is /OCG anywhere; a dictionary whose resolved /Type is /OCMD is an OCMD,
 * and so, conservatively (pdf.js would show its content, as the canonical
 * copy does), is one with any other /Type or none that has /OCGs alongside
 * /P or /VE. An OCMD is evaluated as pdf.js does: /VE (And/Or/Not over
 * groups and nested expressions) over /P (/AnyOn by default, /AllOn,
 * /AnyOff, /AllOff) over /OCGs (one group or an array); a group not listed
 * in /OCProperties /OCGs makes pdf.js show the content. A malformed /VE is
 * refused. /VE evaluation remembers each shared sub-expression's result and
 * counts every operand it visits against PDF_MAX_SEAL_OBJECTS, so a small
 * file of shared sub-arrays cannot make it exponential.
 */
export function optionalContentPolicy(doc: PDFDocument): 'none' | 'all_on' {
  const ocProperties = doc.catalog.lookup(PDFName.of('OCProperties'));
  if (ocProperties === undefined) return 'none';
  const refuse = (): never => {
    throw new SourcePolicyError('hidden_layers');
  };
  if (!isPlainDict(ocProperties)) return refuse();
  const config = ocProperties.lookup(PDFName.of('D'));
  if (config !== undefined) {
    if (!isPlainDict(config)) return refuse();
    const off = config.lookup(PDFName.of('OFF'));
    if (off !== undefined && !(off instanceof PDFArray && off.size() === 0)) refuse();
    const base = config.lookup(PDFName.of('BaseState'));
    if (base !== undefined && base !== PDFName.of('ON')) refuse();
    if (config.has(PDFName.of('AS'))) refuse();
  }

  // The groups pdf.js knows: the references in /OCProperties /OCGs. With the
  // base state ON, nothing in /OFF and every /ViewState /OFF group refused
  // below, every one of them is visible; a reference to any other object is
  // an unknown group, which pdf.js shows.
  const resolve = (value: PDFObject | undefined): PDFObject | undefined =>
    value instanceof PDFRef ? doc.context.lookup(value) : value;
  /** A dictionary's /Type, resolved; undefined unless it is a name. */
  const typeOf = (dict: PDFDict): PDFName | undefined => {
    const type = resolve(dict.get(PDFName.of('Type')));
    return type instanceof PDFName ? type : undefined;
  };
  const viewStateOff = (group: PDFDict): boolean => {
    const usage = resolve(group.get(PDFName.of('Usage')));
    const view = isPlainDict(usage) ? resolve(usage.get(PDFName.of('View'))) : undefined;
    const viewState = isPlainDict(view) ? resolve(view.get(PDFName.of('ViewState'))) : undefined;
    return viewState === PDFName.of('OFF');
  };

  const groups = new Set<string>();
  const listed = ocProperties.lookup(PDFName.of('OCGs'));
  if (listed instanceof PDFArray) {
    for (const raw of listed.asArray()) {
      if (!(raw instanceof PDFRef)) continue;
      groups.add(raw.tag);
      // pdf.js reads every listed object as a group, /Type or not.
      const group = resolve(raw);
      if (isPlainDict(group) && viewStateOff(group)) refuse();
    }
  }
  /** true: a known group, visible; undefined: not a group pdf.js knows. */
  const stateOf = (raw: PDFObject | undefined): boolean | undefined =>
    raw instanceof PDFRef && groups.has(raw.tag) ? true : undefined;

  const maxObjects = getPdfSealLimits().maxSealObjects;
  let steps = 0;
  const step = () => {
    if (++steps > maxObjects) {
      throw new PdfComplexityError('seal_objects', `PDF optional-content expressions take more than ${maxObjects} steps`);
    }
  };
  /** Results of sub-expressions already evaluated, by array and nesting depth. */
  const evaluated = new Map<PDFArray, Map<number, boolean>>();
  const evaluateExpression = (value: PDFObject | undefined, depth: number): boolean => {
    if (depth > MAX_EXPRESSION_NESTING) return refuse();
    const expression = resolve(value);
    if (!(expression instanceof PDFArray) || expression.size() < 2) return refuse();
    const known = evaluated.get(expression)?.get(depth);
    if (known !== undefined) return known;
    const result = evaluateOnce(expression, depth);
    if (!evaluated.has(expression)) evaluated.set(expression, new Map());
    evaluated.get(expression)!.set(depth, result);
    return result;
  };
  const evaluateOnce = (expression: PDFArray, depth: number): boolean => {
    const operator = resolve(expression.get(0));
    const name = operator instanceof PDFName ? operator.decodeText() : undefined;
    if (name !== 'And' && name !== 'Or' && name !== 'Not') return refuse();
    for (let i = 1, n = expression.size(); i < n; i++) {
      step();
      const raw = expression.get(i);
      const operand = resolve(raw);
      let state: boolean;
      if (operand instanceof PDFArray) {
        state = evaluateExpression(operand, depth + 1);
      } else if (raw instanceof PDFRef) {
        const known = stateOf(raw);
        // pdf.js shows the content as soon as it meets an unknown group.
        if (known === undefined) return true;
        state = known;
      } else {
        return refuse();
      }
      if (name === 'And' && !state) return false;
      if (name === 'Or' && state) return true;
      if (name === 'Not') return !state;
    }
    return name === 'And';
  };

  const ocmdVisible = (ocmd: PDFDict): boolean => {
    if (ocmd.has(PDFName.of('VE'))) return evaluateExpression(ocmd.get(PDFName.of('VE')), 1);
    const raw = ocmd.get(PDFName.of('OCGs'));
    const ocgs = resolve(raw);
    let ids: PDFObject[];
    if (ocgs instanceof PDFArray) ids = ocgs.asArray();
    else if (isPlainDict(ocgs)) ids = [raw!];
    else return true; // No groups: pdf.js does not treat it as optional content.
    const policy = resolve(ocmd.get(PDFName.of('P')));
    const name = policy instanceof PDFName ? policy.decodeText() : 'AnyOn';
    // The loops below are pdf.js's, verbatim in effect: an unknown group
    // makes the content visible as soon as it is reached.
    if (name === 'AnyOn') {
      for (const id of ids) if (stateOf(id) !== false) return true;
      return false;
    }
    if (name === 'AllOn') {
      for (const id of ids) {
        const state = stateOf(id);
        if (state === undefined) return true;
        if (!state) return false;
      }
      return true;
    }
    if (name === 'AnyOff') {
      for (const id of ids) if (stateOf(id) !== true) return true;
      return false;
    }
    if (name === 'AllOff') {
      for (const id of ids) {
        const state = stateOf(id);
        if (state === undefined) return true;
        if (state) return false;
      }
      return true;
    }
    return true; // An unknown policy: pdf.js shows the content.
  };

  const inspect = (dict: PDFDict) => {
    const type = typeOf(dict);
    if (type === PDFName.of('OCG')) {
      if (viewStateOff(dict)) refuse();
      return;
    }
    const ocmd = type === PDFName.of('OCMD')
      || (dict.has(PDFName.of('OCGs')) && (dict.has(PDFName.of('P')) || dict.has(PDFName.of('VE'))));
    if (ocmd && !ocmdVisible(dict)) refuse();
  };

  const tooMany = () => new PdfComplexityError('seal_objects', `PDF pages reach more than ${maxObjects} objects`);
  let visits = 0;
  const seen = new Set<PDFObject>();
  const pending: Array<{ object: PDFObject; depth: number }> = doc.context
    .enumerateIndirectObjects()
    .map(([, object]) => ({ object, depth: 0 }));
  while (pending.length) {
    const { object, depth } = pending.pop()!;
    const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : undefined;
    if (!dict && !(object instanceof PDFArray)) continue;
    if (seen.has(object)) continue;
    seen.add(object);
    if (++visits > maxObjects || depth > MAX_DIRECT_DEPTH) throw tooMany();
    let children: PDFObject[];
    if (dict) {
      inspect(dict);
      children = dict.values();
    } else {
      children = (object as PDFArray).asArray();
    }
    // References are not followed: every indirect object is visited anyway.
    for (const child of children) {
      if (child instanceof PDFDict || child instanceof PDFArray) pending.push({ object: child, depth: depth + 1 });
    }
  }
  return 'all_on';
}
