'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getSession } from '@/lib/auth/session';
import { voidEnvelope, sendReminderToNextSigner } from '@/lib/envelopes/lifecycle';
import { createDraft, addEnvelopeFile, addRecipient, addField, setEnvelopeItemPageCount } from '@/lib/envelopes/service';
import { recordEnvelopeEvent } from '@/lib/audit/envelope';
import { readPdfFromStorage } from '@/lib/storage';
import { prisma } from '@/lib/prisma';
import { revalidatePath } from 'next/cache';
import { childLogger } from '@/lib/logger';

export interface VoidActionState {
  ok: boolean;
  error?: string;
}

export async function voidEnvelopeAction(
  _prev: VoidActionState,
  formData: FormData,
): Promise<VoidActionState> {
  const log = childLogger({ action: 'envelope_void' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const parsed = z
    .object({
      envelopeId: z.string().min(1),
      reason: z.string().trim().min(1, 'Reason is required').max(1000),
    })
    .safeParse({
      envelopeId: formData.get('envelopeId'),
      reason: formData.get('reason'),
    });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid request.' };
  }

  try {
    await voidEnvelope({ ctx, envelopeId: parsed.data.envelopeId, reason: parsed.data.reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to void envelope';
    log.error({ err: message, envelopeId: parsed.data.envelopeId }, 'void failed');
    return { ok: false, error: message };
  }
  redirect(`/dashboard/envelopes/${parsed.data.envelopeId}`);
}

export interface ReminderActionState {
  ok: boolean;
  error?: string;
  messageText?: string;
}

export async function sendReminderAction(
  _prev: ReminderActionState,
  formData: FormData,
): Promise<ReminderActionState> {
  const log = childLogger({ action: 'envelope_reminder' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const envelopeId = String(formData.get('envelopeId') ?? '').trim();
  if (!envelopeId) return { ok: false, error: 'Envelope ID is required.' };

  try {
    const result = await sendReminderToNextSigner({ ctx, envelopeId });
    revalidatePath(`/dashboard/envelopes/${envelopeId}`);
    return { ok: true, messageText: `Reminder sent to ${result.recipientName}.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send reminder';
    log.error({ err: message, envelopeId }, 'reminder failed');
    return { ok: false, error: message };
  }
}

/**
 * Clone an envelope — produces a fresh DRAFT with copies of every item,
 * recipient (signing order preserved), and field (with all meta —
 * conditions, formulas, options, validation, defaults). Skipped: signing
 * tokens, signatures, audit chain, attachments, send/sign timestamps. The
 * source envelope is untouched apart from a single `envelope.cloned` audit
 * event recording the new envelope's id. Redirects to the new draft's
 * builder so the sender can edit before send.
 */
export async function cloneEnvelopeAction(formData: FormData): Promise<void> {
  const log = childLogger({ action: 'envelope_clone' });
  const session = await getSession();
  if (!session) throw new Error('Sign in required.');
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const sourceId = String(formData.get('envelopeId') ?? '').trim();
  if (!sourceId) throw new Error('Envelope ID is required.');

  // Authz + load — `getEnvelopeForOwner`-style guard. We also need every
  // field's full meta + recipient + item linkage, so a single deep query.
  const source = await prisma.envelope.findFirst({
    where: { id: sourceId, orgId: session.orgId, deletedAt: null },
    include: {
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' } },
      fields: true,
      meta: true,
    },
  });
  if (!source) throw new Error('Envelope not found.');

  // 1. New draft
  const draft = await createDraft(ctx, {
    title: `Copy of ${source.title}`.slice(0, 200),
    message: source.message ?? undefined,
  });

  // 2. Items — re-read each PDF buffer from storage and add via the same
  //    upload pipeline so storagePath is content-addressed (sha matches the
  //    source). A new EnvelopeItem row is created.
  const itemMap = new Map<string, string>(); // sourceItemId → newItemId
  for (const it of source.items) {
    const buf = await readPdfFromStorage(it.documentFile.storagePath);
    const { item: newItem } = await addEnvelopeFile({
      ctx,
      envelopeId: draft.id,
      buffer: Buffer.from(buf),
      declaredMime: 'application/pdf',
      filename: it.title,
    });
    if (it.pageCount) {
      await setEnvelopeItemPageCount({
        ctx,
        envelopeItemId: newItem.id,
        pageCount: it.pageCount,
      });
    }
    itemMap.set(it.id, newItem.id);
  }

  // 3. Recipients — preserve signingOrder + role + roleLabel. Routing
  //    condition (recipient.meta.condition.whenFieldId) will be remapped in
  //    a second pass once the field id map is built.
  const recipientMap = new Map<string, string>(); // sourceRecipId → newRecipId
  for (const r of source.recipients) {
    const created = await addRecipient({
      ctx,
      envelopeId: draft.id,
      email: r.email,
      name: r.name,
      signingOrder: r.signingOrder,
      role: r.recipientRole === 'CC' ? 'CC' : 'SIGNER',
    });
    recipientMap.set(r.id, created.id);
  }

  // 4. Fields — preserve everything except runtime state (value/filledAt).
  const fieldMap = new Map<string, string>(); // sourceFieldId → newFieldId
  for (const f of source.fields) {
    const newItemId = itemMap.get(f.envelopeItemId);
    const newRecipientId = recipientMap.get(f.recipientId);
    if (!newItemId || !newRecipientId) continue;
    const created = await addField({
      ctx,
      envelopeItemId: newItemId,
      recipientId: newRecipientId,
      type: f.type,
      page: f.page,
      x: Number(f.x),
      y: Number(f.y),
      w: Number(f.w),
      h: Number(f.h),
      required: f.required,
      defaultValue: f.defaultValue ?? undefined,
      meta: (f.meta && typeof f.meta === 'object' ? f.meta : {}) as Record<string, unknown>,
    });
    fieldMap.set(f.id, created.id);
  }

  // 5. Remap cross-field references (condition.whenFieldId, formula refs)
  //    inside each new field's meta now that all DB ids exist.
  for (const f of source.fields) {
    const newId = fieldMap.get(f.id);
    if (!newId) continue;
    const meta = (f.meta && typeof f.meta === 'object' ? f.meta : {}) as {
      condition?: { whenFieldId: string; equals: string };
      formula?: string;
    };
    if (!meta.condition && !meta.formula) continue;
    const next: Record<string, unknown> = { ...meta };
    if (meta.condition) {
      const remappedSrc = fieldMap.get(meta.condition.whenFieldId);
      if (remappedSrc) {
        next.condition = { whenFieldId: remappedSrc, equals: meta.condition.equals };
      } else {
        delete next.condition;
      }
    }
    if (meta.formula) {
      next.formula = meta.formula.replace(/\{([^}]+)\}/g, (_m, raw: string) => {
        const remapped = fieldMap.get(raw.trim());
        return `{${remapped ?? raw.trim()}}`;
      });
    }
    await prisma.field.update({
      where: { id: newId },
      data: { meta: next as Prisma.InputJsonValue },
    });
  }

  // 6. Remap recipient routing conditions.
  for (const r of source.recipients) {
    const newId = recipientMap.get(r.id);
    if (!newId) continue;
    const meta = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as {
      condition?: { whenFieldId: string; equals: string };
    };
    if (!meta.condition) continue;
    const remappedSrc = fieldMap.get(meta.condition.whenFieldId);
    if (!remappedSrc) continue;
    await prisma.recipient.update({
      where: { id: newId },
      data: {
        meta: { condition: { whenFieldId: remappedSrc, equals: meta.condition.equals } } as Prisma.InputJsonValue,
      },
    });
  }

  // 7. Audit — record the clone on the SOURCE envelope so the sender can
  //    trace which copies came from this one.
  await recordEnvelopeEvent({
    envelopeId: source.id,
    type: 'envelope.cloned',
    actorUserId: session.user.id,
    data: { newEnvelopeId: draft.id },
  });

  log.info({ sourceId, newId: draft.id }, 'envelope cloned');
  redirect(`/dashboard/envelopes/${draft.id}`);
}

/**
 * Forward a completed envelope to additional email addresses by minting a
 * view-only share link that bypasses dashboard auth. The token is random
 * 32-byte base64url; valid until `expiresAt`. Each forwarded email gets the
 * same link (one share row per forward action). Expiration default 30 days.
 *
 * Auth: caller must own the source envelope (org match) and the envelope
 * must be COMPLETED. Anything else surfaces a clean error to the form.
 */
export interface ForwardActionState {
  ok: boolean;
  error?: string;
  success?: string;
}

const ForwardSchema = z.object({
  envelopeId: z.string().min(1),
  emails: z.string().trim().min(3, 'Add at least one email address'),
  note: z.string().trim().max(1000).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(365).optional().default(30),
});

export async function forwardCompletedAction(
  _prev: ForwardActionState,
  formData: FormData,
): Promise<ForwardActionState> {
  const log = childLogger({ action: 'envelope_forward' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const parsed = ForwardSchema.safeParse({
    envelopeId: formData.get('envelopeId'),
    emails: formData.get('emails'),
    note: formData.get('note') || undefined,
    expiresInDays: formData.get('expiresInDays') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  const env = await prisma.envelope.findFirst({
    where: { id: parsed.data.envelopeId, orgId: session.orgId, deletedAt: null },
    include: { createdBy: true, org: true },
  });
  if (!env) return { ok: false, error: 'Envelope not found.' };
  if (env.status !== 'COMPLETED') {
    return { ok: false, error: 'Forward is only available on completed envelopes.' };
  }

  // Email parsing — accept comma, semicolon, or newline-separated input.
  // Keep validation strict so a typo doesn't quietly drop a recipient.
  const emails = parsed.data.emails
    .split(/[,;\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: string[] = [];
  for (const e of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: `"${e}" is not a valid email address.` };
    }
    if (!valid.includes(e)) valid.push(e);
  }
  if (valid.length === 0) return { ok: false, error: 'Add at least one email address.' };
  if (valid.length > 25) return { ok: false, error: 'Forward to at most 25 recipients per share.' };

  const { sendMail, isAllowedRecipient } = await import('@/lib/mail');
  const { envelopeForwardTemplate } = await import('@/lib/email/templates');
  const { recordEnvelopeEvent } = await import('@/lib/audit/envelope');
  const { getEnv } = await import('@/lib/env');
  const cryptoNode = await import('node:crypto');

  // Allowlist gate (smtp_relay mode). Refuse the entire action rather than
  // silently dropping recipients — sender expects 100% delivery or none.
  for (const e of valid) {
    if (!isAllowedRecipient(e)) {
      return { ok: false, error: `Email allowlist refused "${e}". Update MAIL_ALLOWLIST or pick a different recipient.` };
    }
  }

  const token = cryptoNode.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);

  await prisma.envelopeShare.create({
    data: {
      envelopeId: env.id,
      token,
      recipientEmails: valid.join(', '),
      note: parsed.data.note ?? null,
      createdById: session.user.id,
      expiresAt,
    },
  });

  const viewUrl = `${getEnv().PUBLIC_URL}/share/${encodeURIComponent(token)}`;
  const forwarderName = env.createdBy?.name ?? session.user.name ?? 'A DocuRidge user';

  for (const email of valid) {
    const tmpl = envelopeForwardTemplate({
      recipientEmail: email,
      forwarderName,
      documentTitle: env.title,
      viewUrl,
      note: parsed.data.note,
      expiresAt,
      emailFooter: env.org?.emailFooter ?? undefined,
      brandColor: env.org?.brandColor ?? undefined,
    });
    await sendMail({
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      orgId: env.orgId,
      envelopeId: env.id,
    });
  }

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.forwarded',
    actorUserId: session.user.id,
    data: { recipientCount: valid.length, expiresAt: expiresAt.toISOString() },
  });

  log.info({ envelopeId: env.id, recipients: valid.length }, 'envelope forwarded');
  revalidatePath(`/dashboard/envelopes/${env.id}`);
  return { ok: true, success: `Forwarded to ${valid.length} recipient${valid.length === 1 ? '' : 's'}.` };
}

/**
 * Bulk-void a set of in-progress envelopes. Each id must belong to the
 * caller's org and be in SENT or IN_PROGRESS — anything else is silently
 * skipped (we don't error the whole batch on one mismatch). Reason is
 * shared across all voided envelopes; defaults to "Voided in bulk by sender".
 */
export async function bulkVoidAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Sign in required.');
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  const ids = formData.getAll('ids').map(String).filter(Boolean);
  const reason = String(formData.get('reason') ?? '').trim() || 'Voided in bulk by sender';
  if (ids.length === 0) return;

  // Authz + status filter via a single query.
  const eligible = await prisma.envelope.findMany({
    where: {
      id: { in: ids },
      orgId: session.orgId,
      deletedAt: null,
      status: { in: ['SENT', 'IN_PROGRESS'] },
    },
    select: { id: true },
  });
  for (const e of eligible) {
    try { await voidEnvelope({ ctx, envelopeId: e.id, reason }); } catch { /* skip individual failures */ }
  }
  revalidatePath('/dashboard/envelopes');
  revalidatePath('/dashboard/sent');
}

/**
 * Bulk soft-delete drafts. Only envelopes with status === DRAFT in the
 * caller's org are affected; sent / in-progress / completed envelopes are
 * skipped (they need to be voided instead, intentionally).
 */
export async function bulkDeleteDraftsAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Sign in required.');
  const ids = formData.getAll('ids').map(String).filter(Boolean);
  if (ids.length === 0) return;

  await prisma.envelope.updateMany({
    where: {
      id: { in: ids },
      orgId: session.orgId,
      deletedAt: null,
      status: 'DRAFT',
    },
    data: { deletedAt: new Date() },
  });
  revalidatePath('/dashboard/envelopes');
  revalidatePath('/dashboard/drafts');
}
