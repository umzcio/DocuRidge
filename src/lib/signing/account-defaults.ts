import type { User } from '@prisma/client';

type DefaultsUser = Pick<
  User,
  | 'email' | 'jobTitle' | 'phone' | 'address' | 'company'
  | 'defaultSignaturePngBase64' | 'defaultTypedSignature'
  | 'defaultInitialsPngBase64' | 'defaultTypedInitials'
>;

export interface RecipientAccountDefaults {
  jobTitle: string | null;
  phone: string | null;
  address: string | null;
  company: string | null;
  signature: { pngBase64: string | null; typed: string | null };
  initials: { pngBase64: string | null; typed: string | null };
}

/**
 * Profile fields and saved marks to pre-fill a signing ceremony with. A
 * signing token only proves someone holds the link, so account data is
 * released only to a dashboard session that belongs to the recipient —
 * never by matching the recipient's email alone.
 */
export function accountDefaultsForRecipient(
  dashSession: { user: DefaultsUser } | null,
  recipientEmail: string,
): RecipientAccountDefaults | null {
  const user = dashSession?.user;
  if (!user || user.email.toLowerCase() !== recipientEmail.toLowerCase()) return null;
  return {
    jobTitle: user.jobTitle ?? null,
    phone: user.phone ?? null,
    address: user.address ?? null,
    company: user.company ?? null,
    signature: { pngBase64: user.defaultSignaturePngBase64 ?? null, typed: user.defaultTypedSignature ?? null },
    initials: { pngBase64: user.defaultInitialsPngBase64 ?? null, typed: user.defaultTypedInitials ?? null },
  };
}
