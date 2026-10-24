import { prisma } from '@/lib/prisma';
import { csvRow } from '@/lib/csv';
import type { EnvelopeStatus, Prisma } from '@prisma/client';

/**
 * Contract pipeline reporting — the "what's pending and with whom" view for
 * Business Services. One org-scoped query powers both the dashboard table and
 * the CSV export so the two can never drift apart.
 *
 * Everything except `pipelineQuery` itself is pure (and unit-tested) so the
 * filter matrix, aging math, and signer-list formatting are covered without a
 * database.
 */

export const PIPELINE_PAGE_SIZE = 50;

const DEFAULT_STATUSES: EnvelopeStatus[] = ['SENT', 'IN_PROGRESS'];
const ALL_STATUSES: EnvelopeStatus[] = [
  'DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED',
];

export interface PipelineFilters {
  /** '' or unset → the default in-flight scope (SENT + IN_PROGRESS);
   *  'ALL' → every non-draft status; otherwise a single EnvelopeStatus. */
  status?: string;
  /** Free-text match on the sender's name or email. */
  sender?: string;
  /** Exact sender filter (used when linking from per-sender views). */
  senderId?: string;
  /** YYYY-MM-DD — only envelopes sent on/after this date. */
  from?: string;
  /** YYYY-MM-DD — only envelopes sent on/before this date. */
  to?: string;
  /** Pagination offset in rows of PIPELINE_PAGE_SIZE. */
  offset?: number;
  /** Export mode: skip pagination and return every matching row (capped). */
  all?: boolean;
}

export interface PipelineRow {
  id: string;
  title: string;
  status: EnvelopeStatus;
  updatedAt: Date;
  sentAt: Date | null;
  senderName: string;
  senderEmail: string;
  /** Names of not-yet-signed recipients, capped at 3 with a "+N" tail. */
  currentSigners: string[];
  /** Emails of not-yet-signed recipients (CSV-only column). */
  currentSignerEmails: string[];
  /** Whole days since sentAt ?? updatedAt — the aging number. */
  daysPending: number;
}

/** Resolve the status filter into a concrete list. Unknown values fall back
 *  to the default in-flight scope so a hand-edited URL can't 500 the page. */
export function resolveStatuses(raw?: string): EnvelopeStatus[] {
  const v = (raw ?? '').trim();
  if (!v) return DEFAULT_STATUSES;
  if (v === 'ALL') return ALL_STATUSES.filter((s) => s !== 'DRAFT');
  return ALL_STATUSES.includes(v as EnvelopeStatus) ? [v as EnvelopeStatus] : DEFAULT_STATUSES;
}

function parseDate(raw?: string): Date | null {
  const v = (raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Build the org-scoped where clause. orgId is always pinned — every filter
 *  composes on top of it, so cross-org leakage is impossible here. */
export function buildPipelineWhere(orgId: string, filters: PipelineFilters): Prisma.EnvelopeWhereInput {
  const where: Prisma.EnvelopeWhereInput = {
    orgId,
    deletedAt: null,
    type: 'DOCUMENT',
    status: { in: resolveStatuses(filters.status) },
  };

  const sender = (filters.sender ?? '').trim();
  if (sender) {
    where.createdBy = {
      OR: [
        { name: { contains: sender, mode: 'insensitive' } },
        { email: { contains: sender.toLowerCase(), mode: 'insensitive' } },
      ],
    };
  }
  if (filters.senderId) where.createdById = filters.senderId;

  const from = parseDate(filters.from);
  const to = parseDate(filters.to);
  if (from || to) {
    const sentAt: Prisma.DateTimeFilter = {};
    if (from) sentAt.gte = from;
    if (to) sentAt.lte = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
    where.sentAt = sentAt;
  }

  return where;
}

/** Whole days elapsed since `date`, floored at 0 for clock skew. */
export function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

/** Not-yet-signed recipient names, capped at `max` with a "+N" tail —
 *  e.g. ['Ada Lovelace', 'Grace Hopper', '+2']. */
export function currentSigners(
  recipients: Array<{ name: string; signingStatus: string }>,
  max = 3,
): string[] {
  const names = recipients.filter((r) => r.signingStatus === 'NOT_SIGNED').map((r) => r.name);
  return names.length > max ? [...names.slice(0, max), `+${names.length - max}`] : names;
}

export function toPipelineRow(
  env: {
    id: string;
    title: string;
    status: EnvelopeStatus;
    updatedAt: Date;
    sentAt: Date | null;
    createdBy: { name: string; email: string };
    recipients: Array<{ name: string; email: string; signingStatus: string }>;
  },
  now: Date,
): PipelineRow {
  const pending = env.recipients.filter((r) => r.signingStatus === 'NOT_SIGNED');
  return {
    id: env.id,
    title: env.title,
    status: env.status,
    updatedAt: env.updatedAt,
    sentAt: env.sentAt,
    senderName: env.createdBy.name,
    senderEmail: env.createdBy.email,
    currentSigners: currentSigners(env.recipients),
    currentSignerEmails: pending.map((r) => r.email),
    daysPending: daysSince(env.sentAt ?? env.updatedAt, now),
  };
}

/** The one query behind both the table and the CSV export. Ordered by sentAt
 *  ascending (oldest pending first) so the aging view reads top-down. */
export async function pipelineQuery(
  orgId: string,
  filters: PipelineFilters,
): Promise<{ rows: PipelineRow[]; total: number }> {
  const where = buildPipelineWhere(orgId, filters);
  const now = new Date();

  if (filters.all) {
    const envelopes = await prisma.envelope.findMany({
      where,
      orderBy: { sentAt: 'asc' },
      take: 5000,
      include: {
        recipients: { orderBy: { signingOrder: 'asc' } },
        createdBy: { select: { name: true, email: true } },
      },
    });
    return { rows: envelopes.map((e) => toPipelineRow(e, now)), total: envelopes.length };
  }

  const offset = Math.max(0, filters.offset ?? 0);
  const [envelopes, total] = await Promise.all([
    prisma.envelope.findMany({
      where,
      orderBy: { sentAt: 'asc' },
      skip: offset,
      take: PIPELINE_PAGE_SIZE,
      include: {
        recipients: { orderBy: { signingOrder: 'asc' } },
        createdBy: { select: { name: true, email: true } },
      },
    }),
    prisma.envelope.count({ where }),
  ]);
  return { rows: envelopes.map((e) => toPipelineRow(e, now)), total };
}

const CSV_HEADER = [
  'Title', 'Status', 'Sender', 'Sender email',
  'Current signers', 'Signer emails', 'Days pending', 'Sent', 'Last update',
];

/** Render rows as CSV matching the on-screen table columns plus the signer
 *  email column the export spec calls for. Every cell goes through
 *  `csvRow`, which quotes it and neutralises spreadsheet formulas — titles
 *  and signer names can come from anonymous public-form submissions. */
export function toCsv(rows: PipelineRow[]): string {
  const lines = [csvRow(CSV_HEADER)];
  for (const r of rows) {
    lines.push(csvRow([
      r.title,
      r.status,
      r.senderName,
      r.senderEmail,
      r.currentSigners.join('; '),
      r.currentSignerEmails.join('; '),
      r.daysPending,
      r.sentAt ? r.sentAt.toISOString().slice(0, 10) : '',
      r.updatedAt.toISOString().slice(0, 10),
    ]));
  }
  return lines.join('\r\n');
}
