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

/**
 * `pages` pages that all point at one indirect /Resources dictionary holding
 * `objects` indirect /ExtGState entries. Cheap to parse and to copy (each
 * object once), but the sealed-content digest walks each page's resources
 * afresh, so digesting it costs `pages` x `objects` visits.
 */
export async function sharedResourceDictPdf(pages: number, objects: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const states: Record<string, ReturnType<typeof doc.context.register>> = {};
  for (let i = 0; i < objects; i++) {
    states[`G${i}`] = doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: 1 }));
  }
  const resources = doc.context.register(doc.context.obj({ ExtGState: doc.context.obj(states) }));
  const content = doc.context.register(doc.context.stream('q /G0 gs Q'));
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 200]);
    page.node.set(PDFName.of('Resources'), resources);
    page.node.set(PDFName.of('Contents'), content);
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
