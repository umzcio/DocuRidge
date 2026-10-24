import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import { PdfComplexityError } from './seal-limits';

/** The page tree is not one that every reader enumerates the same way. */
export class SealedContentStructureError extends Error {
  readonly code = 'sealed_content_page_tree';
  constructor(message: string) {
    super(message);
    this.name = 'SealedContentStructureError';
  }
}

const MAX_PAGE_TREE_DEPTH = 64;
/** Page ceiling for sealed PDFs and for `pageTreeLeaves` without an explicit `maxPages`. */
export const MAX_PAGES = 100_000;

/**
 * The page leaves in reading order, from a strict walk of the catalog's
 * `/Pages` tree.
 *
 * pdf-lib keeps only `/Type /Page` kids and never reads `/Count`, while
 * pdf.js and PDFium take the page count from the root `/Count`, treat a kid
 * without `/Kids` as a page, and use each node's `/Count` to skip subtrees.
 * The walk refuses every tree on which those readings could differ: a kid
 * that is not an indirect `/Type /Page` leaf or `/Type /Pages` node, a
 * `/Count` that is not the number of leaves below it, a `/Parent` that is not
 * the node listing the kid (inherited attributes are read through `/Parent`),
 * a root with a `/Parent`, and any object listed twice.
 */
export function pageTreeLeaves(doc: PDFDocument, opts: { maxPages?: number } = {}): PDFDict[] {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const fail = (message: string): never => {
    throw new SealedContentStructureError(`Malformed page tree: ${message}.`);
  };
  const TYPE = PDFName.of('Type');
  const KIDS = PDFName.of('Kids');
  const PARENT = PDFName.of('Parent');

  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  if (!(rootRef instanceof PDFRef)) fail('the catalog /Pages entry is not an indirect reference');
  const root = doc.context.lookup(rootRef as PDFRef);
  if (!(root instanceof PDFDict) || root instanceof PDFStream || root.get(TYPE) !== PDFName.of('Pages')) {
    fail('the catalog /Pages entry is not a /Type /Pages node');
  }
  if ((root as PDFDict).has(PARENT)) fail('the root /Pages node has a /Parent');

  const leaves: PDFDict[] = [];
  const seen = new Set<string>([(rootRef as PDFRef).tag]);
  const walk = (node: PDFDict, nodeRef: PDFRef, depth: number): number => {
    if (depth > MAX_PAGE_TREE_DEPTH) fail('it is nested too deeply');
    const rawKids = node.get(KIDS);
    const kids = rawKids instanceof PDFRef ? doc.context.lookup(rawKids) : rawKids;
    if (!(kids instanceof PDFArray)) fail(`/Pages node ${nodeRef} has no /Kids array`);
    let count = 0;
    for (let i = 0; i < (kids as PDFArray).size(); i++) {
      const kidRef = (kids as PDFArray).get(i);
      if (!(kidRef instanceof PDFRef)) fail(`a /Kids entry of ${nodeRef} is not an indirect reference`);
      const ref = kidRef as PDFRef;
      if (seen.has(ref.tag)) fail(`${ref} appears in the page tree more than once`);
      seen.add(ref.tag);
      const kid = doc.context.lookup(ref);
      if (!(kid instanceof PDFDict) || kid instanceof PDFStream) fail(`page-tree kid ${ref} is not a dictionary`);
      const dict = kid as PDFDict;
      const parent = dict.get(PARENT);
      if (!(parent instanceof PDFRef) || parent.tag !== nodeRef.tag) fail(`the /Parent of ${ref} is not ${nodeRef}, the node listing it`);
      const type = dict.get(TYPE);
      if (type === PDFName.of('Page')) {
        if (dict.has(KIDS)) fail(`page ${ref} has /Kids`);
        leaves.push(dict);
        if (leaves.length > maxPages) throw new PdfComplexityError('pages', `The document has more than ${maxPages} pages`);
        count += 1;
      } else if (type === PDFName.of('Pages')) {
        count += walk(dict, ref, depth + 1);
      } else {
        fail(`kid ${ref} is neither a /Type /Page leaf nor a /Type /Pages node`);
      }
    }
    const declared = node.get(PDFName.of('Count'));
    if (!(declared instanceof PDFNumber) || declared.asNumber() !== count) {
      fail(`/Count of ${nodeRef} is ${declared instanceof PDFNumber ? declared.asNumber() : 'missing'} but ${count} page(s) are below it`);
    }
    return count;
  };
  walk(root as PDFDict, rootRef as PDFRef, 0);
  return leaves;
}
