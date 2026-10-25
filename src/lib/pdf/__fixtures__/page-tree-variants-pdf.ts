/**
 * Test fixture: two-page PDFs whose page tree has one specific defect.
 *
 * The first group (LENIENT_VARIANTS) are defects pdf.js, PDFium and pdf-lib
 * all read as the same two pages; the source-mode walk must accept them.
 * The second group (REFUSED_VARIANTS) must be refused in either mode.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';

export const LENIENT_VARIANTS = [
  'root_count_high',
  'missing_parent',
  'stale_parent',
  'dangling_parent',
  'intermediate_no_count',
  'indirect_count',
] as const;

export const REFUSED_VARIANTS = [
  'root_count_low',
  'intermediate_count_wrong',
  'untyped_kid',
  'shared_kid',
  'direct_kid',
  'parent_cycle',
  'parent_not_pages',
  'too_deep',
] as const;

export type PageTreeVariant = (typeof LENIENT_VARIANTS)[number] | (typeof REFUSED_VARIANTS)[number] | 'ordinary';

/** Two pages (612x792, a line of text each), with `variant` applied to the page tree. */
export async function pageTreeVariantPdf(variant: PageTreeVariant): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([612, 792]).drawText(`page ${i + 1}`, { x: 50, y: 700 });
  const ctx = doc.context;
  const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
  const root = ctx.lookup(rootRef, PDFDict);
  const kids = root.lookup(PDFName.of('Kids'), PDFArray);
  const pageRefs = [kids.get(0) as PDFRef, kids.get(1) as PDFRef];
  const page = (i: number) => ctx.lookup(pageRefs[i]!, PDFDict);
  const PARENT = PDFName.of('Parent');
  const COUNT = PDFName.of('Count');

  /** root -> mid -> both pages; returns the intermediate node. */
  const nest = (): PDFDict => {
    const midRef = ctx.nextRef();
    const mid = ctx.obj({ Type: 'Pages', Parent: rootRef, Kids: pageRefs, Count: 2 });
    ctx.assign(midRef, mid);
    root.set(PDFName.of('Kids'), ctx.obj([midRef]));
    for (let i = 0; i < 2; i++) page(i).set(PARENT, midRef);
    return mid;
  };
  /** A /Type /Pages node that is not in the tree. */
  const strayNode = (fields: Record<string, unknown> = {}): PDFRef =>
    ctx.register(ctx.obj({ Type: 'Pages', Kids: [], Count: 0, ...(fields as Record<string, never>) }));

  switch (variant) {
    case 'ordinary':
      break;
    case 'root_count_high':
      root.set(COUNT, PDFNumber.of(3));
      break;
    case 'missing_parent':
      page(1).delete(PARENT);
      break;
    case 'stale_parent':
      page(1).set(PARENT, strayNode());
      break;
    case 'dangling_parent':
      page(1).set(PARENT, PDFRef.of(ctx.largestObjectNumber + 50));
      break;
    case 'intermediate_no_count':
      nest().delete(COUNT);
      break;
    case 'indirect_count':
      root.set(COUNT, ctx.register(PDFNumber.of(2)));
      break;
    case 'root_count_low':
      root.set(COUNT, PDFNumber.of(1));
      break;
    case 'intermediate_count_wrong':
      nest().set(COUNT, PDFNumber.of(1));
      break;
    case 'untyped_kid':
      page(1).delete(PDFName.of('Type'));
      break;
    case 'shared_kid':
      root.set(PDFName.of('Kids'), ctx.obj([pageRefs[0]!, pageRefs[1]!, pageRefs[1]!]));
      root.set(COUNT, PDFNumber.of(3));
      break;
    case 'direct_kid':
      kids.set(1, page(1));
      break;
    case 'parent_cycle': {
      // page 2 -> A -> B -> A
      const a = strayNode();
      const b = strayNode({ Parent: a });
      ctx.lookup(a, PDFDict).set(PARENT, b);
      page(1).set(PARENT, a);
      break;
    }
    case 'parent_not_pages':
      page(1).set(PARENT, ctx.register(ctx.obj({ Type: 'Font' })));
      break;
    case 'too_deep': {
      // 70 nested /Pages nodes above the two pages.
      let parentRef = rootRef;
      let holder = root;
      for (let depth = 0; depth < 70; depth++) {
        const ref = ctx.nextRef();
        const node = ctx.obj({ Type: 'Pages', Parent: parentRef, Kids: [], Count: 2 });
        ctx.assign(ref, node);
        holder.set(PDFName.of('Kids'), ctx.obj([ref]));
        parentRef = ref;
        holder = node;
      }
      holder.set(PDFName.of('Kids'), ctx.obj(pageRefs));
      for (let i = 0; i < 2; i++) page(i).set(PARENT, parentRef);
      break;
    }
  }
  return doc.save({ useObjectStreams: false });
}
