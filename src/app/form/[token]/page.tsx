import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { PublicFormClient } from './public-form-client';

export const dynamic = 'force-dynamic';

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const tpl = await prisma.envelope.findUnique({
    where: { publicFormToken: token },
    select: {
      id: true, title: true, type: true, deletedAt: true,
      publicFormEnabled: true,
      message: true,
      org: { select: { name: true, logoBase64: true, logoMimeType: true, brandColor: true } },
      createdBy: { select: { name: true } },
    },
  });
  if (!tpl || tpl.type !== 'TEMPLATE' || tpl.deletedAt || !tpl.publicFormEnabled) notFound();
  const logoSrc = tpl.org?.logoBase64 && tpl.org?.logoMimeType
    ? `data:${tpl.org.logoMimeType};base64,${tpl.org.logoBase64}`
    : null;

  return (
    <div className="min-h-screen bg-page flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-md rounded-lg border border-hairline bg-surface p-7 shadow-[0_4px_16px_rgba(15,17,21,0.06)]">
        {logoSrc ? (
          <img src={logoSrc} alt={tpl.org?.name ?? ''} className="h-10 w-auto mb-5" />
        ) : (
          <p className="text-[12.5px] text-ink-tertiary mb-3">{tpl.org?.name}</p>
        )}
        <h1 className="text-[22px] font-semibold tracking-[-0.018em] text-ink leading-tight">
          {tpl.title}
        </h1>
        <p className="mt-2 text-[13.5px] text-ink-secondary">
          {tpl.createdBy?.name && <>Posted by <strong>{tpl.createdBy.name}</strong>. </>}
          Enter your name and email to start signing.
        </p>
        {tpl.message && (
          <p className="mt-3 rounded-md border border-hairline bg-surface-muted/40 px-3 py-2 text-[12.5px] text-ink whitespace-pre-line">
            {tpl.message}
          </p>
        )}
        <PublicFormClient token={token} brandColor={tpl.org?.brandColor ?? null} />
        <p className="mt-5 text-[11px] text-ink-tertiary leading-snug">
          By proceeding you'll be guided through DocuRidge's standard signing flow,
          including the e-sign disclosure. You can decline at any time.
        </p>
      </div>
    </div>
  );
}
