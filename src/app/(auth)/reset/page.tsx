import Link from 'next/link';
import { ResetRequestForm } from './form';

export default function ResetRequestPage() {
  return (
    <>
      <h2 className="text-xl font-semibold">Reset password</h2>
      <p className="mt-1 text-sm text-neutral-600">
        We&apos;ll email you a link to set a new password.
      </p>
      <div className="mt-6">
        <ResetRequestForm />
      </div>
      <p className="mt-6 text-sm text-center text-neutral-600">
        <Link href="/login" className="text-accent-700 hover:underline">
          Return to sign in
        </Link>
      </p>
    </>
  );
}
