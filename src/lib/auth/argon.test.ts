import { describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import { hashPassword, verifyDummyPassword } from './argon';

describe('verifyDummyPassword', () => {
  it('never accepts a password, including an empty one', async () => {
    await expect(verifyDummyPassword('anything at all')).resolves.toBe(false);
    await expect(verifyDummyPassword('')).resolves.toBe(false);
  });

  it('runs a real Argon2 verify against a hash with the same cost as a stored one', async () => {
    const verify = vi.spyOn(argon2, 'verify');
    await verifyDummyPassword('guess');

    expect(verify).toHaveBeenCalledOnce();
    const [dummyHash] = verify.mock.calls[0]!;
    const stored = await hashPassword('a real password');
    const params = (h: string) => h.split('$')[3];
    expect(params(dummyHash)).toBe(params(stored));
    verify.mockRestore();
  });
});
