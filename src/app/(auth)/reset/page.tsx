import Link from 'next/link';
import { SectionLabel } from '@/components/ui/section-label';
import { ResetRequestForm } from './form';

export default function ResetRequestPage() {
  return (
    <>
      <SectionLabel>Reset password</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-ink">Recover access.</h2>
      <p className="mt-2 text-meta text-ink-secondary">
        We&apos;ll email you a single-use link to set a new password.
      </p>
      <div className="mt-8">
        <ResetRequestForm />
      </div>
      <p className="mt-6 text-meta">
        <Link href="/login" className="text-accent underline underline-offset-2 decoration-1 hover:decoration-2">
          ← Return to sign in
        </Link>
      </p>
    </>
  );
}
