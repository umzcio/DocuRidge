import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPageTree, PDFRef, PDFStream } from 'pdf-lib';
import { assertDrawableSourcePage } from './upright-page';
import { PdfComplexityError, getEnvelopeSealLimits } from './seal-limits';

/** The page tree is not one that every reader enumerates the same way. */
export class SealedContentStructureError extends Error {
  readonly code = 'sealed_content_page_tree';
  constructor(message: string) {
    super(message);
    this.name = 'SealedContentStructureError';
  }
}

const MAX_PAGE_TREE_DEPTH = 64;
/** Nodes on a `/Parent` chain: a leaf under the deepest node, up to the root. */
const MAX_PARENT_CHAIN = MAX_PAGE_TREE_DEPTH + 2;
/** Page ceiling for sealed PDFs and for `pageTreeLeaves` without an explicit `maxPages`. */
export const MAX_PAGES = 100_000;

/**
 * Objects a sealed PDF may hold beyond what its documents' pages carry: the
 * sealer's page wrappers, stamps, fonts, the audit page and the manifest.
 */
export const SEALED_PARSE_OBJECT_HEADROOM = 1_000_000;

/**
 * The parse-object ceiling for loading a sealed PDF: the envelope-wide
 * seal-object cap plus `SEALED_PARSE_OBJECT_HEADROOM`. Separate from
 * `PDF_MAX_PARSE_OBJECTS` (the ceiling on one source upload), because a
 * sealed file holds every document of its envelope, so a genuine seal can
 * hold more objects than any one upload may.
 */
export function sealedMaxParseObjects(): number {
  return getEnvelopeSealLimits().maxSealObjects + SEALED_PARSE_OBJECT_HEADROOM;
}

/**
 * How strictly `pageTreeLeaves` reads the tree.
 *
 *   - `'sealed'`: every reader must enumerate the tree identically, as in a
 *     file pdf-lib wrote. Used for sealed PDFs (content digest, verify) and
 *     canonical copies (when they are made, and again when they are sealed).
 *   - `'source'`: accepts the defects pdf.js, PDFium and pdf-lib all read the
 *     same way, so uploaded documents that open everywhere can be sealed:
 *     a missing, stale or dangling `/Parent` (as long as every `/Parent`
 *     chain is acyclic and bounded), a missing intermediate `/Count`, a root
 *     `/Count` above the page count, and an indirect `/Count`.
 */
export type PageTreeMode = 'sealed' | 'source';

/**
 * The page leaves in reading order, from a walk of the catalog's `/Pages`
 * tree.
 *
 * pdf-lib keeps only `/Type /Page` kids and never reads `/Count`, while
 * pdf.js and PDFium take the page count from the root `/Count`, treat a kid
 * without `/Kids` as a page, and use each node's `/Count` to skip subtrees.
 * Both modes refuse every tree on which those readings could differ: a kid
 * that is not an indirect `/Type /Page` leaf or `/Type /Pages` node, any
 * object listed twice, nesting deeper than 64, an intermediate `/Count` that
 * is present and not the number of leaves below it, a root `/Count` below
 * the number of leaves, and more than `maxPages` leaves.
 *
 * `'sealed'` mode (the default) also refuses a `/Count` that is missing,
 * indirect or above the leaf count, a `/Parent` that is not the node listing
 * the kid (inherited attributes are read through `/Parent`) and a root with
 * a `/Parent`. `'source'` mode accepts those (see PageTreeMode), but still
 * refuses a `/Parent` chain that loops, runs deeper than 64, or reaches
 * anything but a `/Type /Pages` node, since pdf-lib follows it recursively.
 */
export function pageTreeLeaves(
  doc: PDFDocument,
  opts: { maxPages?: number; mode?: PageTreeMode } = {},
): PDFDict[] {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const source = opts.mode === 'source';
  const fail = (message: string): never => {
    throw new SealedContentStructureError(`Malformed page tree: ${message}.`);
  };
  const TYPE = PDFName.of('Type');
  const KIDS = PDFName.of('Kids');
  const PARENT = PDFName.of('Parent');
  const COUNT = PDFName.of('Count');

  // Source mode: every /Parent chain must end (missing or dangling) within
  // the depth limit, through /Type /Pages nodes only. Memoized per node, with
  // the chain length above it, so the check is linear in the tree's size.
  const chainDepth = new Map<string, number>();
  const checkParentChain = (start: PDFDict, startRef: PDFRef): void => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let node: PDFDict = start;
    let tag = startRef.tag;
    let above = 0;
    for (;;) {
      const known = chainDepth.get(tag);
      if (known !== undefined) {
        above = known;
        break;
      }
      if (onPath.has(tag)) fail(`the /Parent chain from ${startRef} loops`);
      path.push(tag);
      onPath.add(tag);
      if (path.length > MAX_PARENT_CHAIN) fail(`the /Parent chain from ${startRef} is too long`);
      const parent = node.get(PARENT);
      if (parent === undefined) break;
      if (!(parent instanceof PDFRef)) fail(`the /Parent of ${tag} is not an indirect reference`);
      const resolved = doc.context.lookup(parent as PDFRef);
      if (resolved === undefined) break; // dangling: pdf-lib and pdf.js both stop here
      if (!(resolved instanceof PDFPageTree) || resolved.get(TYPE) !== PDFName.of('Pages')) {
        fail(`the /Parent of ${tag} is not a /Type /Pages node`);
      }
      node = resolved as PDFDict;
      tag = (parent as PDFRef).tag;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      above += 1;
      if (above > MAX_PARENT_CHAIN) fail(`the /Parent chain from ${startRef} is too long`);
      chainDepth.set(path[i]!, above);
    }
  };
  const declaredCount = (node: PDFDict): number | undefined => {
    const raw = node.get(COUNT);
    const value = source && raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    return value instanceof PDFNumber ? value.asNumber() : undefined;
  };

  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  if (!(rootRef instanceof PDFRef)) fail('the catalog /Pages entry is not an indirect reference');
  const root = doc.context.lookup(rootRef as PDFRef);
  if (!(root instanceof PDFDict) || root instanceof PDFStream || root.get(TYPE) !== PDFName.of('Pages')) {
    fail('the catalog /Pages entry is not a /Type /Pages node');
  }
  if (source) checkParentChain(root as PDFDict, rootRef as PDFRef);
  else if ((root as PDFDict).has(PARENT)) fail('the root /Pages node has a /Parent');

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
      if (source) {
        checkParentChain(dict, ref);
      } else {
        const parent = dict.get(PARENT);
        if (!(parent instanceof PDFRef) || parent.tag !== nodeRef.tag) fail(`the /Parent of ${ref} is not ${nodeRef}, the node listing it`);
      }
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
    const isRoot = depth === 0;
    const declared = declaredCount(node);
    // Source mode reads /Count as pdf.js does: an intermediate node without
    // one is descended into, and a root /Count above the leaves is corrected
    // by counting them. Anything a reader would use to skip or drop pages is
    // still refused.
    const acceptable = !source
      ? declared === count
      : isRoot
        ? declared !== undefined && Number.isSafeInteger(declared) && declared >= count
        : !node.has(COUNT) || declared === count;
    if (!acceptable) {
      fail(`/Count of ${nodeRef} is ${declared ?? (node.has(COUNT) ? 'not a number' : 'missing')} but ${count} page(s) are below it`);
    }
    return count;
  };
  walk(root as PDFDict, rootRef as PDFRef, 0);
  return leaves;
}

/** The only keys the sealer has ever written on a `/Pages` node (pdf-lib's own). */
const BARE_PAGE_TREE_NODE_KEYS = new Set(['/Type', '/Kids', '/Count', '/Parent']);

/**
 * For seals whose digest does not sign the page tree (versions 1 and 2):
 * refuses, with `SealedContentStructureError`, any `/Pages` node carrying a
 * key other than `/Type`, `/Kids`, `/Count` and `/Parent`. Viewers inherit
 * attributes from `/Pages` nodes that those digests never read for a page
 * (pdf.js paints a root `/Annots` on every page that has none of its own),
 * and the sealer writes none, so any such key was added after sealing. Call
 * only after `pageTreeLeaves` accepted the tree (it bounds the walk).
 */
export function assertBarePageTreeNodes(doc: PDFDocument): void {
  const walk = (node: PDFDict, ref: PDFRef): void => {
    const extra = node.keys().map((k) => k.asString()).filter((k) => !BARE_PAGE_TREE_NODE_KEYS.has(k));
    if (extra.length > 0) {
      throw new SealedContentStructureError(
        `Malformed page tree: /Pages node ${ref} has ${extra.join(', ')}, which this digest version does not sign and the sealer never writes.`,
      );
    }
    const kids = node.lookup(PDFName.of('Kids'), PDFArray);
    for (let i = 0; i < kids.size(); i++) {
      const kidRef = kids.get(i) as PDFRef;
      const kid = kids.lookup(i, PDFDict);
      if (kid.get(PDFName.of('Type')) === PDFName.of('Pages')) walk(kid, kidRef);
    }
  };
  const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
  walk(doc.catalog.lookup(PDFName.of('Pages'), PDFDict), rootRef);
}

/**
 * Source mode's second half: every page must have the boxes and attributes
 * sealing reads (`assertDrawableSourcePage`), resolved as pdf-lib resolves
 * them. Source mode accepts a missing, stale or dangling `/Parent`, which can
 * cut a page off from a `/MediaBox` that only the root carries; pdf.js then
 * falls back to Letter, but sealing cannot. Refuses with
 * `SealedContentStructureError`, like the walk. Call it only after
 * `pageTreeLeaves` accepted the tree (it calls `doc.getPages()`).
 */
export function assertSourcePagesDrawable(doc: PDFDocument): void {
  doc.getPages().forEach((page, i) => {
    try {
      assertDrawableSourcePage(page);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new SealedContentStructureError(`Malformed page tree: page ${i + 1} cannot be laid out (${why}).`);
    }
  });
}
