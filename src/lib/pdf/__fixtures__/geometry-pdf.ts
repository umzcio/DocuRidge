/**
 * Test fixture: a page whose displayed size differs from its /MediaBox in
 * every way pdf.js accounts for, so a canonical copy and a seal of it show
 * whether fields land where the sender placed them.
 */
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';

/**
 * One page with /Rotate 90, a 300x200 /CropBox inside a 600x800 /MediaBox,
 * and /UserUnit 2. pdf.js shows it 400 wide and 600 tall.
 */
export async function geometryPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.setCropBox(100, 100, 300, 200);
  page.setRotation(degrees(90));
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  page.drawRectangle({ x: 150, y: 150, width: 50, height: 50 });
  return doc.save();
}
