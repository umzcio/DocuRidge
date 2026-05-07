/**
 * Catalogue of cursive fonts the recipient can pick from when adopting
 * a typed signature or initials. Add a new entry here and it shows up
 * in the SignatureModal font picker, the sealed-PDF stamp, and every
 * preview surface.
 *
 * `cssFamily` is the CSS-side font-family value (uses the next/font CSS
 * variable defined in `src/app/layout.tsx`).
 *
 * `pdfFile` is the path under `/data/fonts/` that pdf-lib will embed
 * into the sealed PDF. Falls back to the default if the file is missing.
 */
export type SignatureFontKey = 'caveat' | 'dancing' | 'great-vibes' | 'sacramento';

export interface SignatureFont {
  key: SignatureFontKey;
  label: string;
  cssFamily: string;
  /** Bundled .ttf file the seal pipeline embeds when stamping. */
  pdfFile: string;
}

export const SIGNATURE_FONTS: SignatureFont[] = [
  {
    key: 'caveat',
    label: 'Caveat',
    cssFamily: 'var(--font-sig), cursive',
    pdfFile: 'Caveat-SemiBold.ttf',
  },
  {
    key: 'dancing',
    label: 'Dancing Script',
    cssFamily: 'var(--font-sig-dancing), cursive',
    pdfFile: 'DancingScript-SemiBold.ttf',
  },
  {
    key: 'great-vibes',
    label: 'Great Vibes',
    cssFamily: 'var(--font-sig-vibes), cursive',
    pdfFile: 'GreatVibes-Regular.ttf',
  },
  {
    key: 'sacramento',
    label: 'Sacramento',
    cssFamily: 'var(--font-sig-sacramento), cursive',
    pdfFile: 'Sacramento-Regular.ttf',
  },
];

export const DEFAULT_SIGNATURE_FONT: SignatureFontKey = 'caveat';

export function fontByKey(key: string | null | undefined): SignatureFont {
  return SIGNATURE_FONTS.find((f) => f.key === key) ?? SIGNATURE_FONTS[0]!;
}

export function isSignatureFontKey(v: string | null | undefined): v is SignatureFontKey {
  return !!v && SIGNATURE_FONTS.some((f) => f.key === v);
}
