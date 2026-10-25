import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fieldCount: vi.fn(),
  fieldCreate: vi.fn(),
  event: vi.fn(),
}));

vi.mock('../prisma', () => ({
  prisma: {
    envelopeItem: {
      findUnique: async () => ({ id: 'item1', envelopeId: 'env1', envelope: { orgId: 'org1' } }),
    },
    envelope: {
      findFirst: async () => ({ id: 'env1', orgId: 'org1', createdById: 'u1', status: 'DRAFT' }),
    },
    recipient: { findUnique: async () => ({ id: 'r1', envelopeId: 'env1' }) },
    field: { count: mocks.fieldCount, create: mocks.fieldCreate },
  },
}));
vi.mock('../audit/envelope', () => ({ recordEnvelopeEvent: mocks.event }));

import { addField } from './service';
import { FieldCapError } from './field-caps';

const ctx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };
const add = () => addField({
  ctx, envelopeItemId: 'item1', recipientId: 'r1', type: 'TEXT', page: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1,
});

/** Answer the envelope-wide count first and the page count second, as addField asks. */
function counts(envelope: number, page: number) {
  mocks.fieldCount.mockImplementation(async ({ where }: { where: { page?: number } }) => (where.page === undefined ? envelope : page));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fieldCreate.mockResolvedValue({ id: 'f-new', type: 'TEXT', page: 1 });
});

describe('addField caps', () => {
  it('adds the 2000th field', async () => {
    counts(1999, 10);
    await expect(add()).resolves.toMatchObject({ id: 'f-new' });
  });

  it('refuses a field past the envelope cap', async () => {
    counts(2000, 10);
    await expect(add()).rejects.toBeInstanceOf(FieldCapError);
    expect(mocks.fieldCreate).not.toHaveBeenCalled();
  });

  it('refuses a field past the page cap', async () => {
    counts(300, 200);
    await expect(add()).rejects.toThrow('A page can have at most 200 fields.');
    expect(mocks.fieldCreate).not.toHaveBeenCalled();
  });
});
