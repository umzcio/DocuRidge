import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnvelopeStatus } from '@prisma/client';

const { findMany, count } = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { envelope: { findMany, count } },
}));

import {
  resolveStatuses,
  buildPipelineWhere,
  daysSince,
  currentSigners,
  toPipelineRow,
  toCsv,
  pipelineQuery,
  PIPELINE_PAGE_SIZE,
} from './query';

describe('resolveStatuses', () => {
  it('defaults to SENT + IN_PROGRESS when unset or blank', () => {
    expect(resolveStatuses(undefined)).toEqual(['SENT', 'IN_PROGRESS']);
    expect(resolveStatuses('')).toEqual(['SENT', 'IN_PROGRESS']);
    expect(resolveStatuses('  ')).toEqual(['SENT', 'IN_PROGRESS']);
  });

  it('ALL means every status except DRAFT', () => {
    const all = resolveStatuses('ALL');
    expect(all).not.toContain('DRAFT');
    expect(all).toEqual(expect.arrayContaining(['SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']));
  });

  it('accepts a single valid status', () => {
    expect(resolveStatuses('COMPLETED')).toEqual(['COMPLETED']);
  });

  it('falls back to the default for unknown values', () => {
    expect(resolveStatuses('BOGUS')).toEqual(['SENT', 'IN_PROGRESS']);
    expect(resolveStatuses('draft')).toEqual(['SENT', 'IN_PROGRESS']); // case-sensitive enum
  });
});

describe('buildPipelineWhere', () => {
  it('always pins orgId and excludes deleted/non-documents', () => {
    const where = buildPipelineWhere('org_1', {});
    expect(where.orgId).toBe('org_1');
    expect(where.deletedAt).toBeNull();
    expect(where.type).toBe('DOCUMENT');
    expect(where.status).toEqual({ in: ['SENT', 'IN_PROGRESS'] });
  });

  it('scopes the sender text search to the creator name/email', () => {
    const where = buildPipelineWhere('org_1', { sender: 'Ada' });
    expect(where.createdBy).toEqual({
      OR: [
        { name: { contains: 'Ada', mode: 'insensitive' } },
        { email: { contains: 'ada', mode: 'insensitive' } },
      ],
    });
  });

  it('supports an exact senderId filter', () => {
    const where = buildPipelineWhere('org_1', { senderId: 'u_1' });
    expect(where.createdById).toBe('u_1');
  });

  it('applies the sent-date range, with `to` covering the whole day', () => {
    const where = buildPipelineWhere('org_1', { from: '2026-08-01', to: '2026-08-31' });
    expect(where.sentAt).toEqual({
      gte: new Date('2026-08-01T00:00:00.000Z'),
      lte: new Date('2026-08-31T23:59:59.999Z'),
    });
  });

  it('ignores malformed dates', () => {
    const where = buildPipelineWhere('org_1', { from: 'not-a-date', to: '2026-13-99' });
    expect(where.sentAt).toBeUndefined();
  });

  it('never lets a filter drop the org scope', () => {
    const where = buildPipelineWhere('org_1', { status: 'ALL', sender: 'x', senderId: 'y' });
    expect(where.orgId).toBe('org_1');
  });
});

describe('daysSince', () => {
  const now = new Date('2026-08-30T12:00:00.000Z');

  it('counts whole elapsed days', () => {
    expect(daysSince(new Date('2026-08-23T12:00:00.000Z'), now)).toBe(7);
    expect(daysSince(new Date('2026-08-23T13:00:00.000Z'), now)).toBe(6); // not yet a full 7th day
  });

  it('floors at zero for future timestamps (clock skew)', () => {
    expect(daysSince(new Date('2026-08-31T00:00:00.000Z'), now)).toBe(0);
  });
});

describe('currentSigners', () => {
  const recipients = [
    { name: 'Ada', signingStatus: 'SIGNED' },
    { name: 'Grace', signingStatus: 'NOT_SIGNED' },
    { name: 'Alan', signingStatus: 'NOT_SIGNED' },
    { name: 'Edsger', signingStatus: 'SKIPPED' },
    { name: 'Barbara', signingStatus: 'NOT_SIGNED' },
  ];

  it('returns only not-yet-signed names', () => {
    expect(currentSigners(recipients)).toEqual(['Grace', 'Alan', 'Barbara']);
  });

  it('caps at 3 names with a "+N" tail', () => {
    expect(currentSigners([...recipients, { name: 'Margaret', signingStatus: 'NOT_SIGNED' }]))
      .toEqual(['Grace', 'Alan', 'Barbara', '+1']);
  });

  it('returns an empty list when everyone has signed', () => {
    expect(currentSigners([{ name: 'Ada', signingStatus: 'SIGNED' }])).toEqual([]);
  });
});

describe('toPipelineRow', () => {
  const now = new Date('2026-08-30T00:00:00.000Z');

  it('maps sender, pending signers, and days-since-sent', () => {
    const row = toPipelineRow({
      id: 'env_1',
      title: 'Offer letter — Hopper',
      status: 'IN_PROGRESS' as EnvelopeStatus,
      updatedAt: new Date('2026-08-29T00:00:00.000Z'),
      sentAt: new Date('2026-08-20T00:00:00.000Z'),
      createdBy: { name: 'HR Ops', email: 'hr@example.edu' },
      recipients: [
        { name: 'Ada', email: 'ada@example.com', signingStatus: 'SIGNED' },
        { name: 'Grace', email: 'grace@example.com', signingStatus: 'NOT_SIGNED' },
      ],
    }, now);
    expect(row.senderName).toBe('HR Ops');
    expect(row.currentSigners).toEqual(['Grace']);
    expect(row.currentSignerEmails).toEqual(['grace@example.com']);
    expect(row.daysPending).toBe(10);
  });

  it('falls back to updatedAt when the envelope was never sent', () => {
    const updatedAt = new Date('2026-08-25T00:00:00.000Z');
    const row = toPipelineRow({
      id: 'env_2',
      title: 'Draft-adjacent',
      status: 'SENT' as EnvelopeStatus,
      updatedAt,
      sentAt: null,
      createdBy: { name: 'HR Ops', email: 'hr@example.edu' },
      recipients: [],
    }, now);
    expect(row.daysPending).toBe(5);
    expect(row.currentSigners).toEqual([]);
  });
});

describe('toCsv', () => {
  const base = {
    id: 'env_1',
    title: 'Offer letter',
    status: 'COMPLETED' as EnvelopeStatus,
    updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    sentAt: new Date('2026-08-20T00:00:00.000Z'),
    senderName: 'HR Ops',
    senderEmail: 'hr@example.edu',
    currentSigners: ['Grace', 'Alan'],
    currentSignerEmails: ['grace@example.com', 'alan@example.com'],
    daysPending: 10,
  };

  it('emits a header row plus one line per row', () => {
    const csv = toCsv([base]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Title,Status,Sender,Sender email,Current signers,Signer emails,Days pending,Sent,Last update');
    expect(lines[1]).toBe('Offer letter,COMPLETED,HR Ops,hr@example.edu,Grace; Alan,grace@example.com; alan@example.com,10,2026-08-20,2026-08-29');
  });

  it('escapes commas, quotes, and newlines', () => {
    const csv = toCsv([{ ...base, title: 'A "special", multi\nline title' }]);
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain('"A ""special"", multi\nline title"');
  });

  it('renders an empty sentAt as an empty cell', () => {
    const csv = toCsv([{ ...base, sentAt: null }]);
    expect(csv.split('\r\n')[1]).toContain(',,2026-08-29');
  });
});

describe('pipelineQuery', () => {
  beforeEach(() => {
    findMany.mockReset();
    count.mockReset();
  });

  it('queries org-scoped, oldest-sent first, one page', async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    await pipelineQuery('org_1', { status: '', offset: 50 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ orgId: 'org_1' }),
      orderBy: { sentAt: 'asc' },
      skip: 50,
      take: PIPELINE_PAGE_SIZE,
    }));
    expect(count).toHaveBeenCalledWith({ where: expect.objectContaining({ orgId: 'org_1' }) });
  });

  it('maps envelopes to rows and returns the total', async () => {
    const now = Date.now();
    findMany.mockResolvedValue([
      {
        id: 'env_1',
        title: 'Vendor agreement',
        status: 'SENT',
        updatedAt: new Date(now - 3 * 86_400_000),
        sentAt: new Date(now - 10 * 86_400_000),
        createdBy: { name: 'Procurement', email: 'proc@example.edu' },
        recipients: [
          { name: 'Grace', email: 'grace@example.com', signingStatus: 'NOT_SIGNED', signingOrder: 1 },
        ],
      },
    ]);
    count.mockResolvedValue(42);

    const { rows, total } = await pipelineQuery('org_1', {});
    expect(total).toBe(42);
    expect(rows).toHaveLength(1);
    const row = rows.at(0);
    expect(row).toMatchObject({
      id: 'env_1',
      senderName: 'Procurement',
      currentSigners: ['Grace'],
      currentSignerEmails: ['grace@example.com'],
    });
    expect(row?.daysPending).toBeGreaterThanOrEqual(10);
  });

  it('export mode (all) skips pagination and the count query', async () => {
    findMany.mockResolvedValue([]);
    await pipelineQuery('org_1', { all: true });
    const arg = findMany.mock.calls[0]?.[0];
    expect(arg.skip).toBeUndefined();
    expect(arg.take).toBe(5000);
    expect(count).not.toHaveBeenCalled();
  });
});
