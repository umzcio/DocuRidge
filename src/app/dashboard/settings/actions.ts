'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { childLogger } from '@/lib/logger';

const ProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Name is required').max(120),
  jobTitle: z.string().trim().max(120).optional(),
  phone:    z.string().trim().max(40).optional(),
  address:  z.string().trim().max(500).optional(),
  company:  z.string().trim().max(160).optional(),
});

const MAX_AVATAR_BYTES = 200 * 1024; // 200KB cap on inline base64 storage
const ALLOWED_AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

export interface ProfileActionState {
  ok: boolean;
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

export async function updateProfileAction(
  _prev: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  const log = childLogger({ action: 'profile_update' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const parsed = ProfileSchema.safeParse({
    fullName: formData.get('fullName'),
    jobTitle: formData.get('jobTitle') || undefined,
    phone:    formData.get('phone')    || undefined,
    address:  formData.get('address')  || undefined,
    company:  formData.get('company')  || undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.errors) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { ok: false, fieldErrors, error: 'Please fix the highlighted fields.' };
  }

  try {
    await prisma.user.update({
      where: { id: session.user.id },
      data: {
        name: parsed.data.fullName,
        jobTitle: parsed.data.jobTitle ?? null,
        phone:    parsed.data.phone    ?? null,
        address:  parsed.data.address  ?? null,
        company:  parsed.data.company  ?? null,
      },
    });
    revalidatePath('/dashboard/settings');
    return { ok: true, success: 'Profile saved.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save profile';
    log.error({ err: message, userId: session.user.id }, 'profile update failed');
    return { ok: false, error: message };
  }
}

const NotificationsSchema = z.object({
  sentForSignature: z.coerce.boolean().default(false),
  recipientSigned: z.coerce.boolean().default(false),
  completed: z.coerce.boolean().default(false),
  declined: z.coerce.boolean().default(false),
  reminderDigest: z.coerce.boolean().default(false),
});

export interface NotificationsActionState {
  ok: boolean;
  error?: string;
  success?: string;
}

export async function updateNotificationsAction(
  _prev: NotificationsActionState,
  formData: FormData,
): Promise<NotificationsActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const parsed = NotificationsSchema.parse({
    sentForSignature: formData.get('sentForSignature') === 'on',
    recipientSigned: formData.get('recipientSigned') === 'on',
    completed: formData.get('completed') === 'on',
    declined: formData.get('declined') === 'on',
    reminderDigest: formData.get('reminderDigest') === 'on',
  });

  await prisma.user.update({
    where: { id: session.user.id },
    data: { notificationPrefs: parsed },
  });
  revalidatePath('/dashboard/settings');
  return { ok: true, success: 'Notification preferences saved.' };
}

export interface AvatarActionState {
  ok: boolean;
  error?: string;
  success?: string;
}

export async function uploadAvatarAction(
  _prev: AvatarActionState,
  formData: FormData,
): Promise<AvatarActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const file = formData.get('avatar');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Pick an image first.' };
  }
  const mime = file.type;
  if (!ALLOWED_AVATAR_MIMES.includes(mime)) {
    return { ok: false, error: 'Avatar must be PNG, JPEG, or WebP.' };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { ok: false, error: `Avatar must be under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.` };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString('base64');

  await prisma.user.update({
    where: { id: session.user.id },
    data: { avatarBase64: base64, avatarMimeType: mime },
  });
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard');
  return { ok: true, success: 'Photo updated.' };
}

export async function removeAvatarAction(
  _prev: AvatarActionState,
  _formData: FormData,
): Promise<AvatarActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  await prisma.user.update({
    where: { id: session.user.id },
    data: { avatarBase64: null, avatarMimeType: null },
  });
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard');
  return { ok: true, success: 'Photo removed.' };
}

/* ─── Branding (admin) ─────────────────────────────────────── */

const BrandingSchema = z.object({
  senderEmailFromName: z.string().trim().max(120).optional(),
  emailFooter: z.string().trim().max(500).optional(),
  brandColor: z.string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex like #2544FB')
    .optional()
    .or(z.literal('')),
  defaultFieldFont: z.enum(['sans', 'serif', 'mono']).optional(),
});

export interface BrandingActionState {
  ok: boolean;
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

export async function updateBrandingAction(
  _prev: BrandingActionState,
  formData: FormData,
): Promise<BrandingActionState> {
  const log = childLogger({ action: 'branding_update' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  if (session.role !== 'ADMIN') return { ok: false, error: 'Only org admins can update branding.' };

  const parsed = BrandingSchema.safeParse({
    senderEmailFromName: formData.get('senderEmailFromName') || undefined,
    emailFooter: formData.get('emailFooter') || undefined,
    brandColor: formData.get('brandColor') || undefined,
    defaultFieldFont: formData.get('defaultFieldFont') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid request.' };
  }

  // Optional logo upload
  const logo = formData.get('logo');
  let logoUpdate: { logoBase64?: string | null; logoMimeType?: string | null } = {};
  if (logo instanceof File && logo.size > 0) {
    if (!ALLOWED_AVATAR_MIMES.includes(logo.type)) {
      return { ok: false, error: 'Logo must be PNG, JPEG, or WebP.' };
    }
    if (logo.size > MAX_AVATAR_BYTES) {
      return { ok: false, error: `Logo must be under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.` };
    }
    const buf = Buffer.from(await logo.arrayBuffer());
    logoUpdate = { logoBase64: buf.toString('base64'), logoMimeType: logo.type };
  }

  try {
    await prisma.organisation.update({
      where: { id: session.orgId },
      data: {
        senderEmailFromName: parsed.data.senderEmailFromName ?? null,
        emailFooter: parsed.data.emailFooter ?? null,
        brandColor: parsed.data.brandColor || null,
        defaultFieldFont: parsed.data.defaultFieldFont ?? null,
        ...logoUpdate,
      },
    });
    revalidatePath('/dashboard/settings');
    return { ok: true, success: 'Branding saved.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save branding';
    log.error({ err: message, orgId: session.orgId }, 'branding update failed');
    return { ok: false, error: message };
  }
}

/* ─── Saved default signature / initials ──────────────────────────── */

export interface SavedSignatureActionState {
  ok: boolean;
  error?: string;
  success?: string;
}

const MAX_SIG_BYTES = 200 * 1024;

/**
 * Persist a default signature (drawn or typed) onto the user's profile so
 * it can be pre-filled in every future signing ceremony. Either pngBase64
 * or typed (or both — drawn wins at render time) may be set; passing null
 * for both clears the saved default. `kind` selects which slot is updated.
 */
export async function saveDefaultSignatureAction(
  _prev: SavedSignatureActionState,
  formData: FormData,
): Promise<SavedSignatureActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const kind = String(formData.get('kind') ?? '');
  if (kind !== 'SIGNATURE' && kind !== 'INITIALS') {
    return { ok: false, error: 'Invalid signature kind.' };
  }

  const pngRaw = formData.get('pngBase64');
  const typedRaw = formData.get('typed');
  const png = typeof pngRaw === 'string' && pngRaw ? pngRaw.replace(/^data:image\/png;base64,/, '') : null;
  const typed = typeof typedRaw === 'string' && typedRaw ? typedRaw.slice(0, 120) : null;

  if (png && Buffer.byteLength(png, 'base64') > MAX_SIG_BYTES) {
    return { ok: false, error: 'Signature image too large.' };
  }

  const data = kind === 'SIGNATURE'
    ? { defaultSignaturePngBase64: png, defaultTypedSignature: typed }
    : { defaultInitialsPngBase64: png, defaultTypedInitials: typed };

  await prisma.user.update({ where: { id: session.user.id }, data });
  revalidatePath('/dashboard/settings');
  return {
    ok: true,
    success: png || typed
      ? 'Default saved. Future envelopes will pre-fill it.'
      : 'Default cleared.',
  };
}

export async function removeOrgLogoAction(
  _prev: AvatarActionState,
  _formData: FormData,
): Promise<AvatarActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  if (session.role !== 'ADMIN') return { ok: false, error: 'Only org admins can update branding.' };
  await prisma.organisation.update({
    where: { id: session.orgId },
    data: { logoBase64: null, logoMimeType: null },
  });
  revalidatePath('/dashboard/settings');
  return { ok: true, success: 'Logo removed.' };
}
