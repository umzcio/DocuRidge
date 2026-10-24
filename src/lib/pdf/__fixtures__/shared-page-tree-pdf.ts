/** Test fixture: a page tree whose nodes are shared, so it has 2^depth paths to one leaf. */
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';

export async function buildSharedNodePageTreePdf(depth: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const pagesRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
  // Built top-down: each level's node is listed twice by the node above it.
  const refs: PDFRef[] = [];
  for (let level = 0; level <= depth; level++) refs.push(ctx.nextRef());
  for (let level = 0; level <= depth; level++) {
    const parent = level === 0 ? pagesRef : refs[level - 1]!;
    const bottom = level === depth;
    ctx.assign(
      refs[level]!,
      bottom
        ? ctx.obj({ Type: 'Page', Parent: parent, MediaBox: [0, 0, 612, 792] })
        : ctx.obj({ Type: 'Pages', Parent: parent, Kids: [refs[level + 1]!, refs[level + 1]!], Count: 2 }),
    );
  }
  const root = ctx.lookup(pagesRef) as PDFDict;
  root.set(PDFName.of('Kids'), ctx.obj([refs[0]!]));
  root.set(PDFName.of('Count'), ctx.obj(1));
  return doc.save();
}
