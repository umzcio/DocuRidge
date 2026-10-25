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

/**
 * Trees source mode accepts, but whose pages sealing could not lay out: a
 * page cut off from the only /MediaBox, or with a box or attribute pdf-lib
 * cannot read. Refused when a source is loaded.
 */
export const UNDRAWABLE_VARIANTS = [
  'missing_parent_root_mediabox',
  'stale_parent_root_mediabox',
  'dangling_parent_root_mediabox',
  'no_mediabox',
  'zero_area_mediabox',
  'cropbox_not_rectangle',
  'rotate_not_number',
  'resources_not_dict',
] as const;

/**
 * Pages whose tree and boxes are fine but whose /Resources, /Annots or
 * /Contents pdf-lib cannot copy: embedding them throws. Refused at upload by
 * running the seal's page pipeline; a seal maps them to a structure error.
 */
export const UNEMBEDDABLE_VARIANTS = [
  'font_array',
  'xobject_number',
  'extgstate_name',
  'inherited_font_array',
  'annots_not_array',
  'contents_number',
  'contents_array_of_non_streams',
] as const;

export type PageTreeVariant =
  | (typeof LENIENT_VARIANTS)[number]
  | (typeof REFUSED_VARIANTS)[number]
  | (typeof UNDRAWABLE_VARIANTS)[number]
  | (typeof UNEMBEDDABLE_VARIANTS)[number]
  | 'ordinary'
  | 'root_mediabox'
  | 'zero_area_cropbox'
  | 'no_contents_resources_not_dict';

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

  /** Move every page's /MediaBox up to the root, as some generators write it. */
  const rootOnlyMediaBox = (): void => {
    root.set(PDFName.of('MediaBox'), ctx.obj([0, 0, 612, 792]));
    for (let i = 0; i < 2; i++) page(i).delete(PDFName.of('MediaBox'));
  };

  switch (variant) {
    case 'ordinary':
      break;
    case 'root_mediabox':
      rootOnlyMediaBox();
      break;
    case 'missing_parent_root_mediabox':
      rootOnlyMediaBox();
      page(1).delete(PARENT);
      break;
    case 'stale_parent_root_mediabox':
      rootOnlyMediaBox();
      page(1).set(PARENT, strayNode());
      break;
    case 'dangling_parent_root_mediabox':
      rootOnlyMediaBox();
      page(1).set(PARENT, PDFRef.of(ctx.largestObjectNumber + 50));
      break;
    case 'no_mediabox':
      for (let i = 0; i < 2; i++) page(i).delete(PDFName.of('MediaBox'));
      break;
    case 'zero_area_mediabox':
      page(1).set(PDFName.of('MediaBox'), ctx.obj([0, 0, 0, 792]));
      break;
    case 'zero_area_cropbox':
      page(1).set(PDFName.of('CropBox'), ctx.obj([10, 10, 10, 500]));
      break;
    case 'cropbox_not_rectangle':
      page(1).set(PDFName.of('CropBox'), ctx.obj([0, 0, 612]));
      break;
    case 'rotate_not_number':
      root.set(PDFName.of('Rotate'), PDFName.of('Ninety'));
      break;
    case 'font_array':
      page(1).lookup(PDFName.of('Resources'), PDFDict).set(PDFName.of('Font'), ctx.obj([1, 2]));
      break;
    case 'xobject_number':
      page(1).lookup(PDFName.of('Resources'), PDFDict).set(PDFName.of('XObject'), PDFNumber.of(3));
      break;
    case 'extgstate_name':
      page(1).lookup(PDFName.of('Resources'), PDFDict).set(PDFName.of('ExtGState'), PDFName.of('GS'));
      break;
    case 'inherited_font_array':
      page(1).delete(PDFName.of('Resources'));
      root.set(PDFName.of('Resources'), ctx.obj({ Font: [1, 2] }));
      break;
    case 'annots_not_array':
      page(1).set(PDFName.of('Annots'), PDFNumber.of(5));
      break;
    case 'contents_number':
      page(1).set(PDFName.of('Contents'), PDFNumber.of(7));
      break;
    case 'contents_array_of_non_streams':
      page(1).set(PDFName.of('Contents'), ctx.obj([ctx.register(ctx.obj({ Length: 0 })), 4]));
      break;
    case 'no_contents_resources_not_dict':
      page(1).delete(PDFName.of('Contents'));
      page(1).set(PDFName.of('Resources'), ctx.obj([1, 2]));
      break;
    case 'resources_not_dict':
      page(1).set(PDFName.of('Resources'), ctx.obj([1, 2]));
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
