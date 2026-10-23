import { hashToken, verifyToken } from '@/lib/auth/tokens';
import { prisma } from '@/lib/prisma';
import { SectionLabel } from '@/components/ui/section-label';
import { Banner } from '@/components/ui/banner';
import { VerifyEmailForm } from './form';

export const dynamic = 'force-dynamic';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token || !(await verifyToken(token, 'email_verification'))) return <Invalid />;
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: await hashToken(token) },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return <Invalid />;

  return (
    <>
      <SectionLabel>Verify email</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-foreground">One last step.</h2>
      <p className="mt-2 text-meta text-muted-foreground">
        Enter the password you chose when you created your account to finish verifying this address.
      </p>
      <div className="mt-8">
        <VerifyEmailForm token={token} />
      </div>
    </>
  );
}

function Invalid() {
  return (
    <>
      <SectionLabel>Verification link invalid</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-foreground">This link expired.</h2>
      <Banner tone="warning" className="mt-6">
        Verification links are valid for 24 hours and can only be used once. Register again, or reset
        your password from the sign-in page, to get a new one.
      </Banner>
    </>
  );
}
