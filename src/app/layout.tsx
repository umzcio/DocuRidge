import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
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
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip-link">Skip to main content</a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
