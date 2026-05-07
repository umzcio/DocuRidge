import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Caveat, Dancing_Script, Great_Vibes, Sacramento } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
  axes: ['opsz'],
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

// Default cursive (natural handwriting). `--font-sig` keeps backwards
// compat with everywhere we already used the legacy variable.
const sig = Caveat({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sig',
  weight: ['600'],
});

// Three additional signature fonts the recipient can pick from when
// adopting a typed signature. Each maps to a CSS variable; the final
// font-family is inlined where rendered.
const sigDancing = Dancing_Script({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sig-dancing',
  weight: ['600'],
});
const sigGreatVibes = Great_Vibes({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sig-vibes',
  weight: ['400'],
});
const sigSacramento = Sacramento({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sig-sacramento',
  weight: ['400'],
});

export const metadata: Metadata = {
  title: 'DocuRidge',
  description: 'Self-hosted e-signature platform',
  icons: {
    icon: [
      { url: '/DocuRidge/favicon.png', type: 'image/png' },
    ],
    apple: '/DocuRidge/favicon.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${sig.variable} ${sigDancing.variable} ${sigGreatVibes.variable} ${sigSacramento.variable}`}>
      <body>
        <a href="#main" className="skip-link">Skip to main content</a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
