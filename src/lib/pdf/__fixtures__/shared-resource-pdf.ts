/** Test fixture: many small pages drawing one large shared image. */
import { randomBytes } from 'node:crypto';
import { PDFDocument, PDFName } from 'pdf-lib';

/**
 * `pages` pages that each draw the same `imageBytes`-byte (incompressible)
 * image. With `inherited`, the image sits in one direct /Resources on the
 * root /Pages node that every page inherits; otherwise each page has its own
 * /Resources pointing at the same image object.
 */
export async function sharedImagePdf(pages: number, imageBytes: number, options: { inherited?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const side = Math.ceil(Math.sqrt(imageBytes));
  const image = doc.context.register(doc.context.stream(randomBytes(side * side), {
    Type: 'XObject', Subtype: 'Image', Width: side, Height: side,
    ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  if (options.inherited) {
    doc.catalog.Pages().set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: image } }));
  }
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 200]);
    if (options.inherited) page.node.delete(PDFName.of('Resources'));
    else page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: image } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`q 100 0 0 100 ${i % 100} 50 cm /Im0 Do Q`)));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
