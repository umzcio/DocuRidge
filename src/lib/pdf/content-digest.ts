/**
 * Per-page content digest of a sealed PDF's rendered output.
 *
 * The digest must be computed from *serialized* bytes, not from the
 * in-memory `PDFDocument` that produced them: pages that were just drawn
 * hold `PDFContentStream` objects, while `decodePDFRawStream` (used here)
 * only understands the `PDFRawStream` form that appears once the document
 * has round-tripped through `save()`/`load()`. Callers must therefore save
 * first and digest the resulting bytes.
 *
 * Within a page, XObject names are visited in sorted order rather than
 * dictionary-iteration order, because PDF dictionary key order is not
 * guaranteed stable across a save/load round trip and the digest must be.
 */

import { createHash } from 'node:crypto';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFPage,
  decodePDFRawStream,
} from 'pdf-lib';

export interface SealedContentDigest {
  algorithm: 'sha256';
  pageCount: number;
  /** Per-page digest of rendered content, in page order. */
  pageDigests: string[];
}

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
function pageContentDigest(doc: PDFDocument, page: PDFPage): string {
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

/** Digest every page of an already-serialized PDF. */
export async function sealedContentDigestFromBytes(
  bytes: Uint8Array,
): Promise<SealedContentDigest> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const pageDigests = pages.map((page) => pageContentDigest(doc, page));
  return {
    algorithm: 'sha256',
    pageCount: pages.length,
    pageDigests,
  };
}
