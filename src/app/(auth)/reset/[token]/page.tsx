import { notFound } from 'next/navigation';
import { hashToken, verifyToken } from '@/lib/auth/tokens';
import { prisma } from '@/lib/prisma';
import { ResetCompleteForm } from './form';

export const dynamic = 'force-dynamic';

export default async function ResetCompletePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const verified = await verifyToken(token, 'password_reset');
  if (!verified) {
    return <Invalid />;
  }
  const tokenHash = await hashToken(token);
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) {
    return <Invalid />;
  }

  return (
    <>
      <h2 className="text-xl font-semibold">Set a new password</h2>
      <p className="mt-1 text-sm text-neutral-600">Choose something only you would type.</p>
      <div className="mt-6">
        <ResetCompleteForm token={token} />
      </div>
    </>
  );
}

function Invalid() {
  return (
    <>
      <h2 className="text-xl font-semibold">Reset link invalid</h2>
      <p className="mt-2 text-sm text-neutral-700">
        This password reset link is invalid, expired, or already used. Request a new one from the
        sign-in page.
      </p>
    </>
  );
}
