import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRecipient: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../prisma', () => ({
  prisma: {
    recipient: { findUnique: mocks.findRecipient },
    fieldAttachment: { findMany: async () => [] },
    $transaction: mocks.transaction,
  },
}));
vi.mock('../audit/envelope', () => ({
  recordEnvelopeEvent: vi.fn(),
  commitWithEnvelopeEvents: async (_envelopeId: string, fn: (tx: unknown, record: unknown) => unknown) =>
    mocks.transaction(fn),
}));
vi.mock('../mail', () => ({ sendMail: vi.fn() }));
vi.mock('../env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docs.example.edu' }) }));
vi.mock('../pdf/seal', () => ({ buildSealedEnvelope: vi.fn(), persistSealedEnvelope: vi.fn() }));

import { completeRecipientSigning } from './lifecycle';
import { MAX_FIELD_VALUE_LENGTH } from '../fields/pattern';

function textField(meta: Record<string, unknown>) {
  return {
    id: 'f1', recipientId: 'r1', type: 'TEXT', required: false, value: null,
    defaultValue: null, meta,
  };
}

function withFields(fields: unknown[]) {
  mocks.findRecipient.mockResolvedValue({
    id: 'r1', envelopeId: 'env1', email: 'signer@example.com', name: 'Signer',
    recipientRole: 'SIGNER',
    envelope: { recipients: [], fields, items: [] },
  });
}

const base = { envelopeId: 'env1', recipientId: 'r1', jti: 'jti1', ipAddress: '203.0.113.9', userAgent: 'vitest' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockRejectedValue(new Error('reached persistence'));
});

describe('completeRecipientSigning field validation', () => {
  it('fails fast on a catastrophic sender pattern instead of hanging', async () => {
    withFields([textField({ pattern: '^(a+)+$' })]);
    const started = Date.now();
    await expect(completeRecipientSigning({ ...base, fieldValues: { f1: `${'a'.repeat(40)}!` } }))
      .rejects.toThrow(/could not be checked/i);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('still enforces an ordinary pattern', async () => {
    withFields([textField({ pattern: '^\\d{5}$', patternMessage: 'Enter a ZIP code.' })]);
    await expect(completeRecipientSigning({ ...base, fieldValues: { f1: 'abc' } }))
      .rejects.toThrow('Enter a ZIP code.');
  });

  it('caps every text value even when the sender set no charLimit', async () => {
    withFields([textField({})]);
    await expect(completeRecipientSigning({
      ...base,
      fieldValues: { f1: 'a'.repeat(MAX_FIELD_VALUE_LENGTH + 1) },
    })).rejects.toThrow(/too long/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('caps values posted for fields the recipient does not own', async () => {
    withFields([textField({})]);
    await expect(completeRecipientSigning({
      ...base,
      fieldValues: { other: 'a'.repeat(MAX_FIELD_VALUE_LENGTH + 1) },
    })).rejects.toThrow(/too long/i);
  });

  it('lets a valid value through to persistence', async () => {
    withFields([textField({ pattern: '^\\d{5}$' })]);
    await expect(completeRecipientSigning({ ...base, fieldValues: { f1: '59812' } }))
      .rejects.toThrow('reached persistence');
  });
});

describe('completeRecipientSigning control characters (the seal cannot draw them)', () => {
  const ofType = (type: string, extra: Record<string, unknown> = {}) => ({ ...textField({}), type, ...extra });

  it.each([['DEL', '\u007f'], ['U+0085', '\u0085'], ['U+0090', '\u0090'], ['a line break', '\n'], ['U+2028', '\u2028'], ['NUL', '\u0000']])(
    'refuses a TEXT value holding %s before anything is stored',
    async (_name, ch) => {
      withFields([ofType('TEXT')]);
      await expect(completeRecipientSigning({ ...base, fieldValues: { f1: `a${ch}b` } }))
        .rejects.toThrow('Text contains unsupported characters.');
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it('stores a pasted tab as a space', async () => {
    withFields([ofType('TEXT')]);
    const fieldValues = { f1: 'a\tb' };
    await expect(completeRecipientSigning({ ...base, fieldValues })).rejects.toThrow('reached persistence');
    expect(fieldValues.f1).toBe('a b');
  });

  it('keeps an ADDRESS on its lines (CRLF and CR as LF) and refuses its other controls', async () => {
    withFields([ofType('ADDRESS')]);
    const fieldValues = { f1: '1 Main St\r\nSuite 2\rTown\tMT' };
    await expect(completeRecipientSigning({ ...base, fieldValues })).rejects.toThrow('reached persistence');
    expect(fieldValues.f1).toBe('1 Main St\nSuite 2\nTown MT');

    await expect(completeRecipientSigning({ ...base, fieldValues: { f1: '1 Main St\u0085Town' } }))
      .rejects.toThrow('Text contains unsupported characters.');
  });

  it.each([
    ['typedSignature', '\t'], ['typedSignature', '\u0090'], ['typedInitials', '\u0085'], ['typedInitials', '\u007f'],
  ] as const)('refuses a %s holding a control character', async (key, ch) => {
    withFields([ofType('TEXT')]);
    await expect(completeRecipientSigning({ ...base, fieldValues: {}, [key]: `A${ch}B` }))
      .rejects.toThrow('Text contains unsupported characters.');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('still matches a read-only default or an option that holds a tab', async () => {
    withFields([
      ofType('TEXT', { defaultValue: 'x\ty', meta: { readOnly: true } }),
      ofType('DROPDOWN', { id: 'f2', meta: { options: ['p\tq'] } }),
    ]);
    await expect(completeRecipientSigning({ ...base, fieldValues: { f1: 'x\ty', f2: 'p\tq' } }))
      .rejects.toThrow('reached persistence');
  });
});
