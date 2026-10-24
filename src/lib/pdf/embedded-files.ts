/**
 * Document-level embedded files of a sealed PDF, and the one rule that says
 * which of them is the DocuRidge manifest.
 *
 * The sealer attaches exactly one file, named exactly `docuridge-manifest.json`,
 * to `/Names /EmbeddedFiles` (pdf-lib also lists its file specification in the
 * catalog `/AF`). Both the verifier and the sealed-content digest (v3) use the
 * rule below, so a second file can never be passed off as, or hidden behind,
 * the manifest:
 *
 *   - the name tree is flattened the way viewers read it (`/Names` pairs and
 *     `/Kids`, in order);
 *   - the manifest is the entry whose name decodes to exactly
 *     `docuridge-manifest.json`. Two such entries are ambiguous and never
 *     treated as the manifest;
 *   - only that entry, and the same file specification object in `/AF`, are
 *     excluded from the digest. Every other entry stays in it.
 */

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRef, PDFStream, PDFString } from 'pdf-lib';

export const MANIFEST_ATTACHMENT_NAME = 'docuridge-manifest.json';

const MAX_NAME_TREE_DEPTH = 32;
const MAX_NAME_TREE_ENTRIES = 10_000;

export interface EmbeddedFileEntry {
  /** The name-tree key as stored. */
  key: PDFObject;
  /** The key decoded as a PDF text string, or null when it is not a string. */
  name: string | null;
  /** The value as stored (normally a reference to a file specification). */
  value: PDFObject;
  /** The resolved file specification dictionary, when the value is one. */
  filespec?: PDFDict;
}

export interface EmbeddedFiles {
  entries: EmbeddedFileEntry[];
  /** The tree was not a well-formed name tree (cycle, bad node, too large). */
  malformed: boolean;
}

/** Decode a PDF text string (PDFDocEncoding or UTF-16BE with BOM). */
export function decodePdfText(obj: PDFObject | undefined): string | null {
  if (obj instanceof PDFHexString || obj instanceof PDFString) {
    try {
      return obj.decodeText();
    } catch {
      return null;
    }
  }
  return null;
}

function resolve(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

/** The catalog's `/Names /EmbeddedFiles` tree root, if any. */
export function embeddedFilesRoot(doc: PDFDocument): PDFObject | undefined {
  const names = resolve(doc, doc.catalog.get(PDFName.of('Names')));
  if (!(names instanceof PDFDict)) return undefined;
  return names.get(PDFName.of('EmbeddedFiles'));
}

/** Every entry of `/Names /EmbeddedFiles`, flattened in viewer order. */
export function listEmbeddedFiles(doc: PDFDocument): EmbeddedFiles {
  const entries: EmbeddedFileEntry[] = [];
  let malformed = false;
  const seen = new Set<PDFObject>();

  const walk = (raw: PDFObject | undefined, depth: number): void => {
    const node = resolve(doc, raw);
    if (!(node instanceof PDFDict) || node instanceof PDFStream || depth > MAX_NAME_TREE_DEPTH || seen.has(node)) {
      malformed = true;
      return;
    }
    seen.add(node);
    const pairs = resolve(doc, node.get(PDFName.of('Names')));
    const kids = resolve(doc, node.get(PDFName.of('Kids')));
    if (pairs === undefined && kids === undefined) return;
    if (pairs !== undefined) {
      if (!(pairs instanceof PDFArray) || pairs.size() % 2 !== 0) {
        malformed = true;
        return;
      }
      for (let i = 0; i < pairs.size(); i += 2) {
        if (entries.length >= MAX_NAME_TREE_ENTRIES) {
          malformed = true;
          return;
        }
        const key = pairs.get(i);
        const value = pairs.get(i + 1);
        const filespec = resolve(doc, value);
        entries.push({
          key,
          name: decodePdfText(resolve(doc, key)),
          value,
          filespec: filespec instanceof PDFDict && !(filespec instanceof PDFStream) ? filespec : undefined,
        });
      }
    }
    if (kids !== undefined) {
      if (!(kids instanceof PDFArray)) {
        malformed = true;
        return;
      }
      for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
    }
  };

  const root = embeddedFilesRoot(doc);
  if (root !== undefined) walk(root, 0);
  return { entries, malformed };
}

/**
 * Index of the manifest entry: the single entry named exactly
 * `docuridge-manifest.json`. -1 when there is none, -2 when there are several.
 */
export function manifestEntryIndex(entries: readonly EmbeddedFileEntry[]): number {
  let found = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.name !== MANIFEST_ATTACHMENT_NAME) continue;
    if (found !== -1) return -2;
    found = i;
  }
  return found;
}

/** The catalog `/AF` array's items, resolved; undefined when there is no `/AF`. */
export function catalogAssociatedFiles(doc: PDFDocument): { items: PDFObject[]; malformed: boolean } | undefined {
  const raw = doc.catalog.get(PDFName.of('AF'));
  if (raw === undefined) return undefined;
  const af = resolve(doc, raw);
  if (!(af instanceof PDFArray)) return { items: [], malformed: true };
  return { items: af.asArray(), malformed: false };
}

/** Whether `obj` (a reference or a dictionary) resolves to `filespec`. */
export function isSameObject(doc: PDFDocument, obj: PDFObject, target: PDFDict | undefined): boolean {
  return target !== undefined && resolve(doc, obj) === target;
}
