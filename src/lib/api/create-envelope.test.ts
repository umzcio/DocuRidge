import { describe, it, expect } from 'vitest';
import {
  CreateEnvelopeBodySchema,
  ApiValidationError,
  buildRoleMappings,
  type TemplateRoleSource,
} from './create-envelope';

describe('CreateEnvelopeBodySchema', () => {
  const valid = {
    templateId: 'tpl_1',
    recipients: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
  };

  it('accepts a minimal valid body', () => {
    const parsed = CreateEnvelopeBodySchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('accepts title, role, and up to 25 recipients', () => {
    const parsed = CreateEnvelopeBodySchema.safeParse({
      ...valid,
      title: 'Q3 agreement',
      recipients: Array.from({ length: 25 }, (_, i) => ({
        name: `Signer ${i}`,
        email: `signer${i}@example.com`,
        role: 'SIGNER',
      })),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing templateId', () => {
    const { templateId: _, ...rest } = valid;
    expect(CreateEnvelopeBodySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects zero recipients', () => {
    expect(CreateEnvelopeBodySchema.safeParse({ templateId: 'tpl_1', recipients: [] }).success).toBe(false);
  });

  it('rejects more than 25 recipients', () => {
    const parsed = CreateEnvelopeBodySchema.safeParse({
      templateId: 'tpl_1',
      recipients: Array.from({ length: 26 }, (_, i) => ({ name: `S${i}`, email: `s${i}@example.com` })),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a recipient with an invalid email', () => {
    const parsed = CreateEnvelopeBodySchema.safeParse({
      templateId: 'tpl_1',
      recipients: [{ name: 'Ada', email: 'not-an-email' }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.errors[0]?.message).toMatch(/valid recipient email/i);
  });

  it('rejects an empty recipient name', () => {
    expect(
      CreateEnvelopeBodySchema.safeParse({ templateId: 'tpl_1', recipients: [{ name: '  ', email: 'a@b.co' }] }).success,
    ).toBe(false);
  });

  it('rejects an empty role label', () => {
    expect(
      CreateEnvelopeBodySchema.safeParse({
        templateId: 'tpl_1',
        recipients: [{ name: 'Ada', email: 'ada@example.com', role: '   ' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty title override', () => {
    expect(
      CreateEnvelopeBodySchema.safeParse({ ...valid, title: '   ' }).success,
    ).toBe(false);
  });
});

describe('buildRoleMappings', () => {
  const roles: TemplateRoleSource[] = [
    { id: 'r1', name: 'Manager', roleLabel: 'Manager' },
    { id: 'r2', name: 'Signer', roleLabel: 'Signer' },
  ];

  it('maps recipients to roles in order when no role is given', () => {
    const mappings = buildRoleMappings(roles, [
      { name: 'Grace', email: 'grace@example.com' },
      { name: 'Alan', email: 'alan@example.com' },
    ]);
    expect(mappings).toEqual({
      r1: { name: 'Grace', email: 'grace@example.com' },
      r2: { name: 'Alan', email: 'alan@example.com' },
    });
  });

  it('matches explicit roles by label case-insensitively, regardless of order', () => {
    const mappings = buildRoleMappings(roles, [
      { name: 'Alan', email: 'alan@example.com', role: 'signer' },
      { name: 'Grace', email: 'grace@example.com', role: 'MANAGER' },
    ]);
    expect(mappings.r1).toEqual({ name: 'Grace', email: 'grace@example.com' });
    expect(mappings.r2).toEqual({ name: 'Alan', email: 'alan@example.com' });
  });

  it('throws when the recipient count does not match the template roles', () => {
    expect(() => buildRoleMappings(roles, [{ name: 'Only', email: 'only@example.com' }])).toThrow(ApiValidationError);
    expect(() =>
      buildRoleMappings(roles, [
        { name: 'A', email: 'a@example.com' },
        { name: 'B', email: 'b@example.com' },
        { name: 'C', email: 'c@example.com' },
      ]),
    ).toThrow(/count/i);
  });

  it('throws when an explicit role does not exist on the template', () => {
    expect(() =>
      buildRoleMappings(roles, [
        { name: 'A', email: 'a@example.com', role: 'CFO' },
        { name: 'B', email: 'b@example.com' },
      ]),
    ).toThrow(/no role named "CFO"/i);
  });
});
