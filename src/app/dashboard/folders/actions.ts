'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { childLogger } from '@/lib/logger';

export interface FolderActionState {
  ok: boolean;
  error?: string;
  success?: string;
  folderId?: string;
}

const NameSchema = z.string().trim().min(1, 'Folder name is required').max(80);

/**
 * Create a folder scoped to the caller's org. Returns the new folder id so
 * the UI can redirect into it. Folders have a `type` (DOCUMENT vs TEMPLATE)
 * so the same name can coexist across both spaces; v1 only uses DOCUMENT.
 */
export async function createFolderAction(
  _prev: FolderActionState,
  formData: FormData,
): Promise<FolderActionState> {
  const log = childLogger({ action: 'folder_create' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const parsed = NameSchema.safeParse(formData.get('name'));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid name.' };
  }
  const parentIdRaw = formData.get('parentId');
  const parentId = typeof parentIdRaw === 'string' && parentIdRaw ? parentIdRaw : null;

  // If parentId is given, verify it belongs to the same org.
  if (parentId) {
    const parent = await prisma.folder.findFirst({
      where: { id: parentId, orgId: session.orgId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) return { ok: false, error: 'Parent folder not found.' };
  }

  const folder = await prisma.folder.create({
    data: {
      orgId: session.orgId,
      parentId,
      name: parsed.data,
      type: 'DOCUMENT',
      createdById: session.user.id,
    },
  });
  log.info({ folderId: folder.id }, 'folder created');
  revalidatePath('/dashboard');
  return { ok: true, folderId: folder.id, success: `"${folder.name}" created.` };
}

/**
 * Rename an existing folder. Authz: caller's org must match.
 */
export async function renameFolderAction(
  _prev: FolderActionState,
  formData: FormData,
): Promise<FolderActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const id = String(formData.get('id') ?? '');
  if (!id) return { ok: false, error: 'Folder ID is required.' };
  const parsed = NameSchema.safeParse(formData.get('name'));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid name.' };
  }

  const updated = await prisma.folder.updateMany({
    where: { id, orgId: session.orgId, deletedAt: null },
    data: { name: parsed.data },
  });
  if (updated.count === 0) return { ok: false, error: 'Folder not found.' };
  revalidatePath('/dashboard');
  return { ok: true, success: 'Folder renamed.' };
}

/**
 * Soft-delete a folder. Envelopes inside the folder are unassigned (no
 * cascade — Envelope.folderId is nullable, set to null). Children
 * subfolders remain (they can be re-parented in the UI later).
 */
export async function deleteFolderAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Sign in required.');
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('Folder ID is required.');

  await prisma.$transaction(async (tx) => {
    const folder = await tx.folder.findFirst({
      where: { id, orgId: session.orgId, deletedAt: null },
      select: { id: true },
    });
    if (!folder) throw new Error('Folder not found.');
    await tx.envelope.updateMany({
      where: { folderId: id, orgId: session.orgId },
      data: { folderId: null },
    });
    await tx.folder.update({ where: { id }, data: { deletedAt: new Date() } });
  });

  revalidatePath('/dashboard');
  redirect('/dashboard/envelopes');
}

const MoveSchema = z.object({
  envelopeId: z.string().min(1),
  folderId: z.string().nullable(),
});

/**
 * Move an envelope into a folder, or to the root (`folderId === null`).
 */
export async function moveEnvelopeToFolderAction(
  _prev: FolderActionState,
  formData: FormData,
): Promise<FolderActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const folderRaw = formData.get('folderId');
  const folderId = typeof folderRaw === 'string' && folderRaw ? folderRaw : null;
  const parsed = MoveSchema.safeParse({
    envelopeId: formData.get('envelopeId'),
    folderId,
  });
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  if (parsed.data.folderId) {
    const folder = await prisma.folder.findFirst({
      where: { id: parsed.data.folderId, orgId: session.orgId, deletedAt: null },
      select: { id: true },
    });
    if (!folder) return { ok: false, error: 'Folder not found.' };
  }

  const updated = await prisma.envelope.updateMany({
    where: { id: parsed.data.envelopeId, orgId: session.orgId, deletedAt: null },
    data: { folderId: parsed.data.folderId },
  });
  if (updated.count === 0) return { ok: false, error: 'Envelope not found.' };
  revalidatePath(`/dashboard/envelopes/${parsed.data.envelopeId}`);
  revalidatePath('/dashboard');
  return { ok: true, success: parsed.data.folderId ? 'Moved to folder.' : 'Removed from folder.' };
}
