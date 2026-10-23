import { describe, expect, it } from 'vitest';
import { accountDefaultsForRecipient } from './account-defaults';

const user = {
  id: 'u1',
  email: 'Victim@Example.com',
  jobTitle: 'Counsel',
  phone: '555-0100',
  address: '1 Main St',
  company: 'Example Co',
  defaultSignaturePngBase64: 'c2ln',
  defaultTypedSignature: 'V. Victim',
  defaultInitialsPngBase64: 'aW5p',
  defaultTypedInitials: 'VV',
};

describe('accountDefaultsForRecipient', () => {
  it('returns nothing to a visitor without a dashboard session', () => {
    expect(accountDefaultsForRecipient(null, 'victim@example.com')).toBeNull();
  });

  it('returns nothing when the signed-in user is someone other than the recipient', () => {
    const other = { ...user, id: 'u2', email: 'attacker@example.com' };
    expect(accountDefaultsForRecipient({ user: other }, 'victim@example.com')).toBeNull();
  });

  it('returns the signed-in recipient their own profile and saved marks', () => {
    expect(accountDefaultsForRecipient({ user }, 'victim@example.com')).toEqual({
      jobTitle: 'Counsel',
      phone: '555-0100',
      address: '1 Main St',
      company: 'Example Co',
      signature: { pngBase64: 'c2ln', typed: 'V. Victim' },
      initials: { pngBase64: 'aW5p', typed: 'VV' },
    });
  });
});
