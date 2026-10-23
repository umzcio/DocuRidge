import Link from 'next/link';

/**
 * Detail-page link to the completion-package certificate PDF
 * (`certificate/route.ts`). Rendered for COMPLETED envelopes by the
 * integration step; styled like the adjacent "Audit JSON" download link.
 */
export function CertificateButton({ envelopeId }: { envelopeId: string }) {
  return (
    <Link
      href={`/dashboard/envelopes/${envelopeId}/certificate`}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground hover:bg-muted/60 transition-colors"
      title="Download the human-readable certificate of completion (PDF)"
    >
      <DownloadIcon /> Certificate
    </Link>
  );
}

function DownloadIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>);
}
