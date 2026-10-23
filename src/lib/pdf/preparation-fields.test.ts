import { describe, expect, it } from 'vitest';
import { assertSafePageDeletion, uniqueFieldLabels } from './preparation-fields';

describe('page editing field dependencies', () => {
  it('rejects deletion of fields referenced by ID, label or recipient condition', () => {
    const amount = { id: 'amount-id', dataLabel: 'Amount' };
    for (const formula of ['{amount-id} * 2', '{Amount} * 2']) {
      const total = { id: 'total', formula };
      expect(() => assertSafePageDeletion([amount, total], [total], [])).toThrow(/formula or condition/);
    }
    expect(() => assertSafePageDeletion([amount], [], [{ condition: { whenFieldId: 'amount-id' } }])).toThrow(/formula or condition/);
  });
  it('allows deleting a field and all dependants together', () => {
    expect(() => assertSafePageDeletion([{ id: 'a' }, { id: 'b', formula: '{a}' }], [], [])).not.toThrow();
  });
  it('keeps AI labels unique to avoid redirecting existing formula references', () => {
    expect(uniqueFieldLabels([{ label: 'Amount' }, { label: 'Amount' }, { label: 'Amount (2)' }], [{ dataLabel: 'Amount' }])).toEqual([{ label: 'Amount (2)' }, { label: 'Amount (3)' }, { label: 'Amount (2) (2)' }]);
  });
});
