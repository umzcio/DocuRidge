import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DocuRidge',
  description: 'Self-hosted e-signature platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
