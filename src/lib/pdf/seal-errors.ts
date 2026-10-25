/**
 * Parent-side seal errors. Kept apart from seal.ts so code that records seal
 * failures (lifecycle.ts) can tell them apart without loading the sealer.
 */
import { SealedContentStructureError } from './page-tree';

/** The sender's text for a document whose canonical copy the seal cannot use. */
export function canonicalSealSourceMessage(title: string): string {
  return `"${title}" could not be prepared for sealing. Replace the document and send it again.`;
}

/**
 * One envelope item could not be taken from its canonical copy (refused,
 * missing, or not the bytes its row names). Thrown only in the parent, by
 * the seal's `canonicalSealSource`, so its title is the item's own title
 * from the database, never text from the PDF worker; a
 * SealedContentStructureError revived from the worker stays the plain class.
 */
export class CanonicalSealSourceError extends SealedContentStructureError {
  constructor(readonly title: string) {
    super(canonicalSealSourceMessage(title));
    this.name = 'CanonicalSealSourceError';
  }
}
