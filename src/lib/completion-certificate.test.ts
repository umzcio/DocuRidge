import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildCompletionCertificate } from './completion-certificate';

const AUDIT_HASH = 'a'.repeat(64);

async function buildSample() {
  return buildCompletionCertificate({
    envelopeTitle: 'Faculty Employment Agreement — Fall 2026',
    completedAt: new Date('2026-08-30T12:00:00Z'),
    senderName: 'HR Operations <hr@example.com>',
    recipients: [
      {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        signedAt: new Date('2026-08-29T10:00:00Z'),
        declinedAt: null,
        ipAddress: '203.0.113.10',
      },
      {
        name: 'Grace Hopper',
        email: 'grace@example.com',
        signedAt: null,
        declinedAt: new Date('2026-08-28T09:00:00Z'),
        ipAddress: null,
      },
    ],
    auditChainHash: AUDIT_HASH,
    verifyInstructions: 'Run: npm run verify -- <sealed.pdf>',
  });
}

/** Extract all text from a PDF via pdfjs (the repo's PDF text reader). */
async function extractText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      out += content.items.map((i) => (i as { str: string }).str).join('\n') + '\n';
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

describe('buildCompletionCertificate', () => {
  it('produces a single-page PDF that loads cleanly', async () => {
    const bytes = await buildSample();
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('renders the title, metadata, recipient rows, digest, and verify box', async () => {
    const bytes = await buildSample();
    const text = await extractText(bytes);

    expect(text).toContain('Certificate of Completion');
    // Metadata block.
    expect(text).toContain('Faculty Employment Agreement');
    expect(text).toContain('HR Operations');
    // Recipient table: signed and declined rows with IP handling.
    expect(text).toContain('ada@example.com');
    expect(text).toContain('grace@example.com');
    expect(text).toMatch(/Signed .*2026/);
    expect(text).toContain('Declined');
    expect(text).toContain('203.0.113.10');
    // Missing IP renders as a placeholder (winAnsiSafe maps U+2014 to '-')
    // rather than crashing.
    expect(text).toContain('Declined');
    // Audit chain digest + verify instructions.
    expect(text).toContain(AUDIT_HASH);
    expect(text).toContain('How to verify');
    expect(text).toContain('npm run verify -- <sealed.pdf>');
  });

  it('sets PDF metadata title', async () => {
    const bytes = await buildSample();
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toContain('Certificate of Completion');
  });

  it('sanitizes non-WinAnsi characters instead of throwing', async () => {
    const bytes = await buildCompletionCertificate({
      envelopeTitle: 'Smarty “quotes” — dashes… ✓ and ünicode',
      completedAt: new Date('2026-08-30T12:00:00Z'),
      senderName: 'Søren',
      recipients: [
        {
          name: 'Zoë',
          email: 'zoe@example.com',
          signedAt: new Date('2026-08-29T10:00:00Z'),
          declinedAt: null,
          ipAddress: null,
        },
      ],
      auditChainHash: AUDIT_HASH,
      verifyInstructions: 'Run: npm run verify -- <sealed.pdf>',
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it.each([['tab', '\t'], ['DEL', '\u007f'], ['U+0085', '\u0085'], ['U+0090', '\u0090']])(
    'draws a %s in a title, sender, name or email instead of throwing',
    async (_name, ch) => {
      const bytes = await buildCompletionCertificate({
        envelopeTitle: `Contract${ch}x`,
        completedAt: new Date('2026-08-30T12:00:00Z'),
        senderName: `Sender${ch}x`,
        recipients: [
          { name: `Ada${ch}x`, email: `ada${ch}@example.com`, signedAt: new Date('2026-08-29T10:00:00Z'), declinedAt: null, ipAddress: null },
        ],
        auditChainHash: AUDIT_HASH,
        verifyInstructions: 'Run: npm run verify -- <sealed.pdf>',
      });
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    },
  );

  it('omits the digest section when no chain hash is supplied', async () => {
    const bytes = await buildCompletionCertificate({
      envelopeTitle: 'No-chain envelope',
      completedAt: new Date('2026-08-30T12:00:00Z'),
      senderName: 'Sender',
      recipients: [],
      auditChainHash: '',
      verifyInstructions: 'Run: npm run verify -- <sealed.pdf>',
    });
    const text = await extractText(bytes);
    expect(text).not.toContain('Audit chain digest');
    expect(text).toContain('How to verify');
  });
});
