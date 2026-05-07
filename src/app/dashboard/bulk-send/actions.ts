'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createHash } from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { instantiateTemplate } from '@/lib/templates/service';
import { sendEnvelope } from '@/lib/envelopes/lifecycle';
import { isAllowedRecipient } from '@/lib/mail';
import { childLogger } from '@/lib/logger';

const log = childLogger({ action: 'bulk_send' });

export interface BulkSendActionState {
  ok: boolean;
  error?: string;
  jobId?: string;
}

const StartSchema = z.object({
  templateId: z.string().min(1),
  csv: z.string().trim().min(1, 'CSV file is empty'),
  filename: z.string().max(200).optional(),
});

/**
 * Parse a CSV body. Strict, no library: trims whitespace, requires a header
 * row, splits on commas (no quoting in v1 — UM templates won't need it).
 * Returns the header array + one record per data row keyed by lowercase
 * header name. Empty rows are skipped.
 */
function parseCsv(body: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('CSV must have a header row plus at least one data row.');
  }
  const headers = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',').map((c) => c.trim());
    const rec: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      rec[headers[j]!] = cells[j] ?? '';
    }
    rows.push(rec);
  }
  return { headers, rows };
}

/**
 * Kick off a bulk-send job. Parses the CSV, creates the job + per-row
 * records, then synchronously instantiates an envelope per row and sends
 * it. Synchronous keeps v1 simple — for ≤50-row jobs this finishes in
 * a couple of seconds. Background queue is a v1.1 upgrade.
 *
 * CSV shape: header row with at least `name` and `email` columns. Optional
 * additional columns map to template recipient roles by lowercase name —
 * future: per-field overrides. v1 only routes to a single SIGNER role.
 */
export async function startBulkSendAction(
  _prev: BulkSendActionState,
  formData: FormData,
): Promise<BulkSendActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const file = formData.get('csv');
  let csvBody: string;
  let filename = String(formData.get('filename') ?? 'bulk.csv');
  if (file instanceof File && file.size > 0) {
    csvBody = await file.text();
    filename = file.name;
  } else {
    return { ok: false, error: 'Upload a CSV file.' };
  }

  const parsed = StartSchema.safeParse({
    templateId: formData.get('templateId'),
    csv: csvBody,
    filename,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  // Parse CSV before touching the DB so a malformed file fails fast.
  let rows: Record<string, string>[];
  let headers: string[];
  try {
    const out = parseCsv(parsed.data.csv);
    headers = out.headers;
    rows = out.rows;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'CSV parse failed.' };
  }
  if (!headers.includes('name') || !headers.includes('email')) {
    return { ok: false, error: 'CSV must include columns named "name" and "email".' };
  }
  if (rows.length === 0) {
    return { ok: false, error: 'CSV has no data rows.' };
  }
  if (rows.length > 200) {
    return { ok: false, error: `Bulk send is capped at 200 rows; got ${rows.length}.` };
  }

  // Validate template + read its recipient set so we know which role to map.
  const tpl = await prisma.envelope.findFirst({
    where: { id: parsed.data.templateId, orgId: session.orgId, deletedAt: null, type: 'TEMPLATE' },
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });
  if (!tpl) return { ok: false, error: 'Template not found.' };
  const signerRecipients = tpl.recipients.filter(
    (r) => r.recipientRole === 'SIGNER' || r.recipientRole === 'WITNESS' || r.recipientRole === 'IN_PERSON_SIGNER',
  );
  if (signerRecipients.length === 0) {
    return { ok: false, error: 'Template has no signing recipients.' };
  }
  if (signerRecipients.length > 1) {
    return { ok: false, error: 'Bulk send v1 only supports templates with a single signing recipient.' };
  }
  const targetRole = signerRecipients[0]!;

  // Quick row-level validation pass — fail the whole job rather than half-sending.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const name = (r.name ?? '').trim();
    const email = (r.email ?? '').trim();
    if (!name) return { ok: false, error: `Row ${i + 2}: missing name.` };
    if (!email) return { ok: false, error: `Row ${i + 2}: missing email.` };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: `Row ${i + 2}: "${email}" is not a valid email.` };
    }
  }

  // Create the job + row records in one transaction so the dashboard always
  // shows the full picture even if processing fails halfway.
  const csvSha256 = createHash('sha256').update(parsed.data.csv).digest('hex');
  const job = await prisma.$transaction(async (tx) => {
    const j = await tx.bulkSendJob.create({
      data: {
        orgId: session.orgId,
        templateEnvelopeId: tpl.id,
        createdById: session.user.id,
        status: 'RUNNING',
        totalRows: rows.length,
        csvFilename: filename.slice(0, 200),
        csvSha256,
      },
    });
    await tx.bulkSendRow.createMany({
      data: rows.map((r, i) => ({
        jobId: j.id,
        rowNumber: i + 2, // 1-indexed with header offset; matches CSV line numbers
        recipientMap: { name: r.name ?? '', email: (r.email ?? '').toLowerCase() } as Prisma.InputJsonValue,
      })),
    });
    return j;
  });

  // Fire-and-forget the actual send loop. The job id is already returned to
  // the caller so the UI can redirect into the status page; rows update as
  // each send completes.
  void processBulkSend(job.id, ctx, targetRole.id).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err), jobId: job.id }, 'bulk send loop failed');
  });

  log.info({ jobId: job.id, rowCount: rows.length, templateId: tpl.id }, 'bulk send started');
  redirect(`/dashboard/bulk-send/${job.id}`);
}

async function processBulkSend(
  jobId: string,
  ctx: { userId: string; orgId: string; role: 'ADMIN' | 'SENDER' | 'VIEWER' },
  targetRoleRecipientId: string,
): Promise<void> {
  const rows = await prisma.bulkSendRow.findMany({
    where: { jobId, status: 'PENDING' },
    orderBy: { rowNumber: 'asc' },
  });
  for (const row of rows) {
    const m = row.recipientMap as { name: string; email: string };
    if (!isAllowedRecipient(m.email)) {
      await prisma.bulkSendRow.update({
        where: { id: row.id },
        data: { status: 'SKIPPED_ALLOWLIST', error: 'Email not on allowlist (smtp_relay mode)' },
      });
      continue;
    }
    try {
      const { envelopeId } = await instantiateTemplate({
        ctx,
        templateId: (await prisma.bulkSendJob.findUnique({
          where: { id: jobId }, select: { templateEnvelopeId: true },
        }))!.templateEnvelopeId,
        roleMappings: { [targetRoleRecipientId]: { name: m.name, email: m.email } },
      });
      await sendEnvelope({ ctx, envelopeId });
      await prisma.bulkSendRow.update({
        where: { id: row.id },
        data: { status: 'DISPATCHED', envelopeId },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.bulkSendRow.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: msg.slice(0, 500) },
      });
    }
  }
  // Aggregate the final counts onto the job row.
  const counts = await prisma.bulkSendRow.groupBy({
    by: ['status'],
    where: { jobId },
    _count: { _all: true },
  });
  const succeeded = counts.find((c) => c.status === 'DISPATCHED')?._count._all ?? 0;
  const failed = (counts.find((c) => c.status === 'FAILED')?._count._all ?? 0)
    + (counts.find((c) => c.status === 'SKIPPED_ALLOWLIST')?._count._all ?? 0);
  await prisma.bulkSendJob.update({
    where: { id: jobId },
    data: {
      succeededRows: succeeded,
      failedRows: failed,
      status: 'COMPLETED',
      completedAt: new Date(),
    },
  });
  revalidatePath(`/dashboard/bulk-send/${jobId}`);
}

// Re-export Prisma for the InputJsonValue cast above without a direct import.
import { Prisma } from '@prisma/client';
