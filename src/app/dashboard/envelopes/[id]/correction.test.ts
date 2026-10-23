import { describe, it, expect } from 'vitest';
import {
  ACTIONABLE_ROLES,
  isActionableRole,
  canCorrectEnvelope,
  canMutateRecipient,
  canRemoveRecipient,
  CorrectEnvelopeSchema,
  parseExpirationInput,
  type CorrectionRecipient,
} from './correction';

function recip(overrides: Partial<CorrectionRecipient> = {}): CorrectionRecipient {
  return {
    id: 'r1',
    name: 'Jane Doe',
    email: 'jane@example.edu',
    recipientRole: 'SIGNER',
    signingStatus: 'NOT_SIGNED',
    ...overrides,
  };
}

describe('canCorrectEnvelope', () => {
  it('allows SENT and IN_PROGRESS', () => {
    expect(canCorrectEnvelope('SENT')).toBe(true);
    expect(canCorrectEnvelope('IN_PROGRESS')).toBe(true);
  });

  it('refuses every terminal or pre-send status', () => {
    for (const status of ['DRAFT', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']) {
      expect(canCorrectEnvelope(status)).toBe(false);
    }
  });
});

describe('canMutateRecipient', () => {
  it('allows NOT_SIGNED recipients', () => {
    expect(canMutateRecipient(recip())).toBe(true);
  });

  it('refuses recipients who already acted', () => {
    expect(canMutateRecipient(recip({ signingStatus: 'SIGNED' }))).toBe(false);
    expect(canMutateRecipient(recip({ signingStatus: 'DECLINED' }))).toBe(false);
    expect(canMutateRecipient(recip({ signingStatus: 'SKIPPED' }))).toBe(false);
  });
});

describe('isActionableRole', () => {
  it('counts the four field-filling / routing roles', () => {
    for (const role of ACTIONABLE_ROLES) expect(isActionableRole(role)).toBe(true);
  });

  it('excludes observers', () => {
    expect(isActionableRole('CC')).toBe(false);
    expect(isActionableRole('VIEWER')).toBe(false);
  });
});

describe('canRemoveRecipient', () => {
  it('refuses to remove a recipient who already signed', () => {
    const target = recip({ signingStatus: 'SIGNED' });
    const others = [recip({ id: 'r2' })];
    expect(canRemoveRecipient({ recipient: target, recipients: [target, ...others] }).ok).toBe(false);
  });

  it('refuses to remove the last remaining signer (sequential)', () => {
    const target = recip({ id: 'r2' });
    const signed = recip({ id: 'r1', signingStatus: 'SIGNED' });
    const result = canRemoveRecipient({ recipient: target, recipients: [signed, target] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/last remaining signer/i);
  });

  it('refuses to remove the last remaining signer (parallel)', () => {
    const target = recip({ id: 'r2' });
    const other = recip({ id: 'r1', signingStatus: 'SIGNED' });
    expect(canRemoveRecipient({ recipient: target, recipients: [other, target] }).ok).toBe(false);
  });

  it('allows removal while another signer is still pending', () => {
    const target = recip({ id: 'r1' });
    const pending = recip({ id: 'r2' });
    const cc = recip({ id: 'r3', recipientRole: 'CC' });
    expect(canRemoveRecipient({ recipient: target, recipients: [target, pending, cc] }).ok).toBe(true);
  });

  it('does not count CC recipients as remaining signers', () => {
    const target = recip({ id: 'r1' });
    const onlyCc = recip({ id: 'r2', recipientRole: 'CC' });
    expect(canRemoveRecipient({ recipient: target, recipients: [target, onlyCc] }).ok).toBe(false);
  });
});

describe('CorrectEnvelopeSchema', () => {
  const base = { envelopeId: 'env_1' };

  it('accepts updateDetails with empty optional fields', () => {
    const parsed = CorrectEnvelopeSchema.safeParse({ ...base, operation: 'updateDetails' });
    expect(parsed.success).toBe(true);
  });

  it('requires name and a valid email for addRecipient', () => {
    expect(
      CorrectEnvelopeSchema.safeParse({ ...base, operation: 'addRecipient', name: '  ', email: 'a@b.edu' }).success,
    ).toBe(false);
    expect(
      CorrectEnvelopeSchema.safeParse({ ...base, operation: 'addRecipient', name: 'Jane', email: 'not-an-email' }).success,
    ).toBe(false);
    expect(
      CorrectEnvelopeSchema.safeParse({ ...base, operation: 'addRecipient', name: 'Jane', email: 'a@b.edu', role: 'CC' }).success,
    ).toBe(true);
  });

  it('requires recipientId for replace and remove', () => {
    expect(
      CorrectEnvelopeSchema.safeParse({ ...base, operation: 'removeRecipient' }).success,
    ).toBe(false);
    expect(
      CorrectEnvelopeSchema.safeParse({
        ...base,
        operation: 'replaceRecipient',
        recipientId: 'r1',
        name: 'Jane',
        email: 'a@b.edu',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown operations and roles', () => {
    expect(CorrectEnvelopeSchema.safeParse({ ...base, operation: 'deleteEverything' }).success).toBe(false);
    expect(
      CorrectEnvelopeSchema.safeParse({ ...base, operation: 'addRecipient', name: 'J', email: 'a@b.edu', role: 'CEO' }).success,
    ).toBe(false);
  });
});

describe('parseExpirationInput', () => {
  it('treats blank as "clear expiration"', () => {
    expect(parseExpirationInput('')).toEqual({ ok: true, value: null });
    expect(parseExpirationInput(undefined)).toEqual({ ok: true, value: null });
    expect(parseExpirationInput('   ')).toEqual({ ok: true, value: null });
  });

  it('parses YYYY-MM-DD to the end of that day (local time)', () => {
    const result = parseExpirationInput('2026-12-31');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value!.getFullYear()).toBe(2026);
      expect(result.value!.getMonth()).toBe(11);
      expect(result.value!.getDate()).toBe(31);
      expect(result.value!.getHours()).toBe(23);
      expect(result.value!.getMinutes()).toBe(59);
    }
  });

  it('rejects malformed and impossible dates', () => {
    expect(parseExpirationInput('12/31/2026').ok).toBe(false);
    expect(parseExpirationInput('2026-13-01').ok).toBe(false);
    expect(parseExpirationInput('2026-02-30').ok).toBe(false);
    expect(parseExpirationInput('not-a-date').ok).toBe(false);
  });
});
