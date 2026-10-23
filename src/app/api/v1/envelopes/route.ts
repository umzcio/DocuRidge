import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guardApiRequest } from '@/lib/api/guard';
import { resolveApiActor } from '@/lib/api/auth';
import {
  CreateEnvelopeBodySchema,
  ApiValidationError,
  buildRoleMappings,
} from '@/lib/api/create-envelope';
import { serializeEnvelopeSummary } from '@/lib/api/serializers';
import { instantiateTemplate } from '@/lib/templates/service';
import { sendEnvelope } from '@/lib/envelopes/lifecycle';
import { childLogger } from '@/lib/logger';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STATUSES = ['DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Opaque cursor = base64url of `${sentAt ISO}|${id}`. */
function encodeCursor(sentAt: Date, id: string): string {
  return Buffer.from(`${sentAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(raw: string): { sentAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const sentAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(sentAt.getTime()) || !id) return null;
    return { sentAt, id };
  } catch {
    return null;
  }
}

/**
 * GET /api/v1/envelopes?status=&q=&limit=&cursor=
 *
 * Org comes from the bearer token — never from query params. Cursor pagination
 * over (sentAt desc, id desc); `nextCursor` is null on the final page.
 */
export async function GET(req: NextRequest) {
  const guard = await guardApiRequest(req, 'read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `Invalid status "${status}".` }, { status: 400 });
  }

  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT));

  const cursorRaw = url.searchParams.get('cursor');
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return NextResponse.json({ error: 'Malformed cursor.' }, { status: 400 });
  }

  const q = url.searchParams.get('q')?.trim();

  // Multiple optional filters combine with AND so a search + cursor never
  // collide on the same `OR` key.
  const filters: Prisma.EnvelopeWhereInput[] = [];
  if (q) {
    filters.push({
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { recipients: { some: { email: { contains: q.toLowerCase() } } } },
      ],
    });
  }
  if (cursor) {
    filters.push({
      OR: [
        { sentAt: { lt: cursor.sentAt } },
        { sentAt: cursor.sentAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.envelope.findMany({
    where: {
      orgId: guard.auth.token.orgId,
      deletedAt: null,
      type: 'DOCUMENT',
      ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
      ...(filters.length > 0 ? { AND: filters } : {}),
    },
    orderBy: [
      { sentAt: { sort: 'desc', nulls: 'last' } },
      { id: 'desc' },
    ],
    take: limit + 1,
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last?.sentAt ? encodeCursor(last.sentAt, last.id) : null;

  return NextResponse.json({ envelopes: page.map(serializeEnvelopeSummary), nextCursor });
}

/**
 * POST /api/v1/envelopes — instantiate a template and send it. Requires the
 * `write` scope. The org and sender identity come from the bearer token; the
 * body only supplies the template id, an optional title override, and the
 * recipient list. Sending reuses the exact same machinery as the dashboard
 * (instantiateTemplate + sendEnvelope) — no parallel send path.
 */
export async function POST(req: NextRequest) {
  const guard = await guardApiRequest(req, 'write');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const parsed = CreateEnvelopeBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid request body.' },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const ctx = await resolveApiActor(guard.auth.token.orgId, guard.auth.token.userId);
  if (!ctx) {
    return NextResponse.json({ error: 'Token creator is no longer a member of this organization.' }, { status: 403 });
  }

  const template = await prisma.envelope.findFirst({
    where: {
      id: input.templateId,
      orgId: guard.auth.token.orgId,
      deletedAt: null,
      type: 'TEMPLATE',
    },
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });
  if (!template) {
    return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
  }

  let roleMappings: Record<string, { name: string; email: string }>;
  try {
    roleMappings = buildRoleMappings(template.recipients, input.recipients);
  } catch (err) {
    if (err instanceof ApiValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const log = childLogger({ route: 'api-create-envelope' });
  try {
    const { envelopeId } = await instantiateTemplate({ ctx, templateId: template.id, roleMappings });
    if (input.title) {
      await prisma.envelope.update({ where: { id: envelopeId }, data: { title: input.title } });
    }
    await sendEnvelope({ ctx, envelopeId });
    const env = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });
    log.info({ envelopeId, templateId: template.id, tokenId: guard.auth.token.id }, 'envelope created via API');
    return NextResponse.json({ envelopeId, status: env?.status ?? 'SENT' }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create envelope.';
    log.error({ err: message, templateId: template.id }, 'API envelope creation failed');
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
