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

import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFPageLeaf, PDFRef, PDFStream, type PDFDocument, type PDFObject } from 'pdf-lib';
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
      const flags = annot.lookup(PDFName.of('F'));
      const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
      if (Number.isInteger(f) && (f & (FLAG_HIDDEN | FLAG_NOVIEW)) !== 0) continue;
      const subtype = annot.lookup(SUBTYPE);
      const inert = subtype === PDFName.of('Link') || subtype === PDFName.of('Popup');
      if (inert && !hasNormalAppearance(annot)) continue;
      throw new SourcePolicyError('visible_annotations');
    }
  }
}

/** An optional-content membership dictionary, by shape: /OCGs, /P or /VE. */
function isOcmd(dict: PDFDict): boolean {
  return dict.has(PDFName.of('OCGs')) || dict.has(PDFName.of('P')) || dict.has(PDFName.of('VE'));
}

/** A page's /Resources, as the page inherits it. */
function pageResources(leaf: PDFDict): PDFObject | undefined {
  const key = PDFName.of('Resources');
  const raw = leaf instanceof PDFPageLeaf ? leaf.getInheritableAttribute(key) : leaf.get(key);
  return raw instanceof PDFRef ? leaf.context.lookup(raw) : raw;
}

/**
 * Decide what to do with /OCProperties. `'none'` when the file has none.
 * `'all_on'` when it has them and every group is on (the caller drops them).
 * Anything that makes some content conditional is refused as `hidden_layers`:
 * a non-empty /D /OFF, a /BaseState other than /ON, a /D /AS, or an OCMD
 * reachable from a page (in /Resources /Properties, or as the /OC of an
 * XObject, descending through form XObjects).
 */
export function optionalContentPolicy(doc: PDFDocument, leaves: PDFDict[]): 'none' | 'all_on' {
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

  const maxObjects = getPdfSealLimits().maxSealObjects;
  let visits = 0;
  const seen = new Set<PDFObject>();
  const pending: Array<PDFObject | undefined> = [];
  const OC = PDFName.of('OC');
  const resolve = (value: PDFObject | undefined): PDFObject | undefined =>
    value instanceof PDFRef ? doc.context.lookup(value) : value;
  const visit = (resources: PDFObject | undefined) => {
    const dict = resolve(resources);
    if (!isPlainDict(dict) || seen.has(dict)) return;
    seen.add(dict);
    const properties = resolve(dict.get(PDFName.of('Properties')));
    if (isPlainDict(properties)) {
      for (const [, value] of properties.entries()) {
        if (++visits > maxObjects) throw new PdfComplexityError('seal_objects', `PDF pages reach more than ${maxObjects} objects`);
        const entry = resolve(value);
        if (isPlainDict(entry) && isOcmd(entry)) refuse();
      }
    }
    const xobjects = resolve(dict.get(PDFName.of('XObject')));
    if (isPlainDict(xobjects)) {
      for (const [, value] of xobjects.entries()) {
        if (++visits > maxObjects) throw new PdfComplexityError('seal_objects', `PDF pages reach more than ${maxObjects} objects`);
        const xobject = resolve(value);
        if (!(xobject instanceof PDFStream) || seen.has(xobject)) continue;
        seen.add(xobject);
        const oc = resolve(xobject.dict.get(OC));
        if (isPlainDict(oc) && isOcmd(oc)) refuse();
        pending.push(xobject.dict.get(PDFName.of('Resources')));
      }
    }
  };
  for (const leaf of leaves) {
    visit(pageResources(leaf));
    while (pending.length) visit(pending.pop());
  }
  return 'all_on';
}
