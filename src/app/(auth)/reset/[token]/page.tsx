import { hashToken, verifyToken } from '@/lib/auth/tokens';
import { prisma } from '@/lib/prisma';
import { SectionLabel } from '@/components/ui/section-label';
import { Banner } from '@/components/ui/banner';
import { ResetCompleteForm } from './form';

export const dynamic = 'force-dynamic';

export default async function ResetCompletePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const verified = await verifyToken(token, 'password_reset');
  if (!verified) return <Invalid />;
  const tokenHash = await hashToken(token);
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) {
    return <Invalid />;
  }

  return (
    <>
      <SectionLabel>Set new password</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-ink">A clean restart.</h2>
      <p className="mt-2 text-meta text-ink-secondary">Choose something only you would type.</p>
      <div className="mt-8">
        <ResetCompleteForm token={token} />
      </div>
    </>
  );
}

function Invalid() {
  return (
    <>
      <SectionLabel>Reset link invalid</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-ink">This link expired.</h2>
      <Banner tone="warning" className="mt-6">
        Reset links are valid for 1 hour and can only be used once. Request a new one from the sign-in page.
      </Banner>
    </>
  );
}
