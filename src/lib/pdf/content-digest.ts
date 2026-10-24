/**
 * Per-page content digest of a sealed PDF's rendered output.
 *
 * The digest must be computed from *serialized* bytes, not from the
 * in-memory `PDFDocument` that produced them: pages that were just drawn
 * hold `PDFContentStream` objects, while the raw form the digest reads only
 * appears once the document has round-tripped through `save()`/`load()`.
 * Callers must therefore save first and digest the resulting bytes.
 *
 * Three versions exist, recorded in the manifest as `sealedContent.digestVersion`:
 *
 *   1 (legacy; manifests without `digestVersion`): page size, decoded
 *     `/Contents`, and the decoded payload of each direct `/XObject`. It
 *     misses nested resources, fonts, stream dictionaries, annotations, page
 *     boxes and `/Rotate`, so a body edited in those places still matched.
 *     Kept only so seals made with it still verify.
 *
 *   2 (legacy, 2026-10-23): a canonical walk of everything reachable from the page
 *     dictionary — inherited `/Resources`, `/MediaBox`, `/CropBox`, `/Rotate`,
 *     every other page key (`/Annots` with appearance streams, `/BleedBox`,
 *     `/TrimBox`, `/ArtBox`, `/UserUnit`, `/Group`, ...), resources at any
 *     depth, and every stream's dictionary plus raw bytes — plus the
 *     catalog entries that change how pages render (`/OCProperties`,
 *     `/AcroForm`, `/Names` other than `/EmbeddedFiles`, ...). Streams are
 *     hashed as stored (filters and parameters are covered via the dictionary),
 *     so nothing is decoded. Excluded, because sealing writes them after the
 *     digest is taken or they lead off this page: `/Length`, the catalog's
 *     `/Pages`, `/AF` and `/Names /EmbeddedFiles` (the manifest attachment),
 *     and references to page or page-tree dictionaries, which are recorded as
 *     a page index rather than followed. So neither the page tree nor the
 *     attachment set is signed.
 *
 *   3 (current): everything in version 2, plus
 *     - the page tree: every `/Pages` node from the root down (its keys,
 *       including `/Count` and inheritable attributes, and its `/Kids` in
 *       order, each kid recorded as a page index or walked as a node), and
 *       every page digest carries its page index. Adding, removing, hiding,
 *       re-ordering or re-parenting a page changes a signed value;
 *     - the document-level embedded files: every `/Names /EmbeddedFiles`
 *       entry and every catalog `/AF` item except the manifest attachment,
 *       which the seal adds after the digest. embedded-files.ts defines
 *       exactly which one entry that is; the verifier separately requires
 *       that entry to carry nothing but the manifest.
 *
 * Every version first walks the page tree strictly (`pageTreeLeaves`). Every
 * kid must be an indirect `/Type /Page` leaf or `/Type /Pages` node whose
 * `/Parent` is the node listing it. Every `/Count` must equal the leaves
 * below it, and no object may appear twice. A tree that a viewer could
 * enumerate differently from pdf-lib throws `SealedContentStructureError`
 * instead of being digested. pdf-lib writes a flat, consistent tree, so
 * genuine seals of every version pass.
 *
 * Dictionary keys are visited in sorted order, and indirect objects are
 * numbered in first-visit order, because neither key order nor object numbers
 * are stable across a save/load round trip and the digest must be.
 */

import { createHash, type Hash } from 'node:crypto';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { withPdfDecodeBudget } from './decode-limits';
import { SealedContentStructureError, pageTreeLeaves } from './page-tree';

export { SealedContentStructureError, pageTreeLeaves };
import { catalogAssociatedFiles, isSameObject, listEmbeddedFiles, manifestEntryIndex } from './embedded-files';

export type SealedContentDigestVersion = 1 | 2 | 3;
export const CURRENT_SEALED_CONTENT_DIGEST_VERSION: SealedContentDigestVersion = 3;
export const SUPPORTED_SEALED_CONTENT_DIGEST_VERSIONS: readonly number[] = [1, 2, 3];

export interface SealedContentDigest {
  algorithm: 'sha256';
  /** Absent on manifests sealed before versioning, which used version 1. */
  digestVersion?: SealedContentDigestVersion;
  pageCount: number;
  /** Per-page digest of rendered content, in page order. */
  pageDigests: string[];
}

/** The digest version a manifest's `sealedContent` was computed with. */
export function sealedContentDigestVersion(declared: { digestVersion?: unknown }): number {
  return declared.digestVersion === undefined ? 1 : Number(declared.digestVersion);
}

// ─── Version 1 (legacy) ────────────────────────────────────────────────────

/** Resolve a Contents / XObject entry (stream | ref | array) to decoded byte chunks. */
function decodedStreams(doc: PDFDocument, obj: unknown): Uint8Array[] {
  const out: Uint8Array[] = [];
  const push = (o: unknown): void => {
    const resolved = o instanceof PDFRef ? doc.context.lookup(o) : o;
    if (resolved instanceof PDFRawStream) {
      out.push(decodePDFRawStream(resolved).decode());
    } else if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) push(resolved.get(i));
    }
  };
  push(obj);
  return out;
}

/** Digest one page's MediaBox, Contents streams, and XObject streams. */
function pageContentDigestV1(doc: PDFDocument, page: PDFPage): string {
  const h = createHash('sha256');
  const node = page.node;

  // MediaBox first, so a crop that leaves the content streams untouched
  // still changes the digest.
  const { width, height } = page.getSize();
  h.update(`${width}x${height}`);

  for (const chunk of decodedStreams(doc, node.get(PDFName.of('Contents')))) {
    h.update(chunk);
  }

  const res = node.get(PDFName.of('Resources'));
  const resDict = res instanceof PDFRef ? doc.context.lookup(res) : res;
  if (resDict instanceof PDFDict) {
    const xo = resDict.get(PDFName.of('XObject'));
    const xoDict = xo instanceof PDFRef ? doc.context.lookup(xo) : xo;
    if (xoDict instanceof PDFDict) {
      // Name-sorted so the digest doesn't depend on dictionary iteration order.
      const names = xoDict.keys().map((k) => k.asString()).sort();
      for (const name of names) {
        h.update(name);
        const key = PDFName.of(name.replace(/^\//, ''));
        for (const chunk of decodedStreams(doc, xoDict.get(key))) {
          h.update(chunk);
        }
      }
    }
  }
  return h.digest('hex');
}

// ─── Page tree (all versions) ──────────────────────────────────────────────

// ─── Versions 2 and 3 ──────────────────────────────────────────────────────

const INHERITABLE_PAGE_KEYS = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;
const CATALOG_EXCLUDED_KEYS = new Set(['/Pages', '/AF']);
const PAGE_TREE_NODE_EXCLUDED_KEYS = new Set(['/Kids', '/Parent']);
const MAX_GRAPH_DEPTH = 512;

interface Visitor {
  dictEntries(entries: [string, PDFObject][], depth: number): void;
  value(obj: PDFObject | undefined, depth: number): void;
  token(tag: string, body?: string): void;
}

class GraphDigester {
  /** Raw-content hash per stream object, shared across pages. */
  private readonly streamHashes = new WeakMap<PDFStream, string>();
  private readonly pageIndex = new Map<PDFDict, number>();
  private readonly pageTreeNodes = new Set<PDFDict>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly version: 2 | 3,
  ) {
    doc.getPages().forEach((page, i) => this.pageIndex.set(page.node, i));
    const pages = doc.catalog.lookupMaybe(PDFName.of('Pages'), PDFDict);
    const walk = (node: PDFDict | undefined, depth: number): void => {
      if (!node || depth > MAX_GRAPH_DEPTH || this.pageTreeNodes.has(node)) return;
      this.pageTreeNodes.add(node);
      const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
      for (let i = 0; i < (kids?.size() ?? 0); i++) {
        const kid = kids!.lookup(i);
        if (kid instanceof PDFDict && !this.pageIndex.has(kid)) walk(kid, depth + 1);
      }
    };
    walk(pages, 0);
  }

  /** Canonical digest of catalog entries that affect rendering, shared by all pages. */
  documentDigest(): string {
    const h = createHash('sha256');
    const visit = this.visitor(h);
    const catalog = this.doc.catalog;
    const entries: [string, PDFObject][] = [];
    for (const [key, value] of catalog.entries()) {
      const name = key.asString();
      if (CATALOG_EXCLUDED_KEYS.has(name)) continue;
      if (name === '/Names') {
        const names = this.resolve(value);
        if (!(names instanceof PDFDict)) {
          entries.push([name, value]);
          continue;
        }
        const kept = names.entries().filter(([k]) => k.asString() !== '/EmbeddedFiles');
        if (kept.length > 0) entries.push([name, this.doc.context.obj(Object.fromEntries(kept.map(([k, v]) => [k.asString().slice(1), v]))) as PDFObject]);
        continue;
      }
      entries.push([name, value]);
    }
    visit.dictEntries(entries, 0);
    if (this.version >= 3) {
      const root = this.doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
      visit.token('T', String(this.pageIndex.size));
      this.pageTree(visit, root, 0);
      this.embeddedFiles(visit);
    }
    return h.digest('hex');
  }

  /**
   * v3: every document-level embedded file except the manifest attachment.
   * The seal takes the digest before attaching the manifest, so a genuine
   * seal has none; exactly one name-tree entry (the one named
   * `docuridge-manifest.json`, when that name is unique) and the same file
   * specification in `/AF` are left out, and everything else is signed.
   */
  private embeddedFiles(visit: Visitor): void {
    const files = listEmbeddedFiles(this.doc);
    const manifest = manifestEntryIndex(files.entries);
    const kept = files.entries.filter((_, i) => i !== manifest);
    visit.token('E', `${kept.length}${files.malformed ? '!' : ''}`);
    for (const entry of kept) {
      visit.value(entry.key, 0);
      visit.value(entry.value, 0);
    }
    const af = catalogAssociatedFiles(this.doc);
    const manifestSpec = manifest >= 0 ? files.entries[manifest]!.filespec : undefined;
    const afKept = (af?.items ?? []).filter((item) => !isSameObject(this.doc, item, manifestSpec));
    visit.token('F', `${afKept.length}${af?.malformed ? '!' : ''}`);
    for (const item of afKept) visit.value(item, 0);
  }

  /** v3: a page-tree node, its own keys and its kids in order (pages as indices). */
  private pageTree(visit: Visitor, node: PDFDict, depth: number): void {
    if (depth > MAX_GRAPH_DEPTH) throw new Error('PDF page tree is too deep to digest');
    visit.token('N');
    visit.dictEntries(
      node.entries().filter(([k]) => !PAGE_TREE_NODE_EXCLUDED_KEYS.has(k.asString())).map(([k, v]) => [k.asString(), v]),
      depth + 1,
    );
    const kids = node.lookup(PDFName.of('Kids'), PDFArray);
    visit.token('K', String(kids.size()));
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i, PDFDict);
      const index = this.pageIndex.get(kid);
      if (index !== undefined) visit.token('P', String(index));
      else this.pageTree(visit, kid, depth + 1);
    }
  }

  pageDigest(page: PDFPage, documentDigest: string, index: number): string {
    const h = createHash('sha256');
    h.update(
      this.version >= 3
        ? `docuridge-page-digest-v3\0${documentDigest}\0${index}\0`
        : `docuridge-page-digest-v2\0${documentDigest}\0`,
    );
    const node = page.node;
    const entries: [string, PDFObject][] = node.entries()
      .filter(([k]) => k.asString() !== '/Parent')
      .map(([k, v]) => [k.asString(), v]);
    for (const key of INHERITABLE_PAGE_KEYS) {
      if (node.has(PDFName.of(key))) continue;
      const inherited = node.getInheritableAttribute(PDFName.of(key));
      if (inherited !== undefined) entries.push([`/${key}`, inherited]);
    }
    this.visitor(h, node).dictEntries(entries, 0);
    return h.digest('hex');
  }

  private resolve(obj: PDFObject | undefined): PDFObject | undefined {
    return obj instanceof PDFRef ? this.doc.context.lookup(obj) : obj;
  }

  private streamHash(stream: PDFStream): string {
    let hex = this.streamHashes.get(stream);
    if (!hex) {
      const bytes = stream instanceof PDFRawStream ? stream.contents : stream.getContents();
      hex = createHash('sha256').update(bytes).digest('hex');
      this.streamHashes.set(stream, hex);
    }
    return hex;
  }

  /** A per-page traversal: fresh first-visit numbering, so each page digest stands alone. */
  private visitor(h: Hash, root?: PDFDict): Visitor {
    const visited = new Map<PDFObject, number>();
    if (root) visited.set(root, 0);
    const token = (tag: string, body = ''): void => {
      h.update(`${tag}${body.length}:${body}`);
    };

    const value = (obj: PDFObject | undefined, depth: number): void => {
      if (depth > MAX_GRAPH_DEPTH) throw new Error('PDF object graph is too deep to digest');
      if (obj === undefined) return token('U');
      const target = this.resolve(obj);
      if (target === undefined) return token('U');

      if (target instanceof PDFDict && !(target instanceof PDFStream)) {
        const page = this.pageIndex.get(target);
        if (target !== root && page !== undefined) return token('P', String(page));
        if (target !== root && this.pageTreeNodes.has(target)) return token('T');
      }
      const seen = visited.get(target);
      if (seen !== undefined) return token('R', String(seen));
      if (target instanceof PDFDict || target instanceof PDFArray || target instanceof PDFStream) {
        visited.set(target, visited.size);
      }

      if (target instanceof PDFStream) {
        token('S');
        dictEntries(
          target.dict.entries().filter(([k]) => k.asString() !== '/Length').map(([k, v]) => [k.asString(), v]),
          depth + 1,
        );
        return token('B', this.streamHash(target));
      }
      if (target instanceof PDFDict) {
        return dictEntries(target.entries().map(([k, v]) => [k.asString(), v]), depth + 1);
      }
      if (target instanceof PDFArray) {
        token('A', String(target.size()));
        for (let i = 0; i < target.size(); i++) value(target.get(i), depth + 1);
        return;
      }
      const size = target.sizeInBytes();
      const bytes = new Uint8Array(size);
      target.copyBytesInto(bytes, 0);
      token('V', Buffer.from(bytes).toString('latin1'));
    };

    const dictEntries = (entries: [string, PDFObject][], depth: number): void => {
      const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      token('D', String(sorted.length));
      for (const [key, v] of sorted) {
        token('K', key);
        value(v, depth);
      }
    };

    return { dictEntries, value, token };
  }
}

/** Digest every page of an already-serialized PDF. */
export async function sealedContentDigestFromBytes(
  bytes: Uint8Array,
  digestVersion: SealedContentDigestVersion = CURRENT_SEALED_CONTENT_DIGEST_VERSION,
): Promise<SealedContentDigest> {
  // The verifier runs this on files from anywhere, so parsing and any stream
  // decodes below share one bounded decode budget.
  return withPdfDecodeBudget(async () => {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    // Strict walk first: it also rejects cycles before pdf-lib's own
    // (recursive, unguarded) page-tree traversal runs.
    const leaves = pageTreeLeaves(doc);
    const pages = doc.getPages();
    if (pages.length !== leaves.length || pages.some((page, i) => page.node !== leaves[i])) {
      throw new SealedContentStructureError('Malformed page tree: pdf-lib enumerates different pages than the page tree.');
    }
    if (digestVersion === 1) {
      return {
        algorithm: 'sha256' as const,
        pageCount: pages.length,
        pageDigests: pages.map((page) => pageContentDigestV1(doc, page)),
      };
    }
    const digester = new GraphDigester(doc, digestVersion);
    const documentDigest = digester.documentDigest();
    return {
      algorithm: 'sha256' as const,
      digestVersion,
      pageCount: pages.length,
      pageDigests: pages.map((page, i) => digester.pageDigest(page, documentDigest, i)),
    };
  });
}
