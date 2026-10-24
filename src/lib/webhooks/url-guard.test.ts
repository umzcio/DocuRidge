import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));

import { checkWebhookUrl, vetWebhookUrl, WEBHOOK_TARGET_REFUSED_MESSAGE } from './url-guard';

function answer(...addresses: string[]) {
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

const ORIGINAL_ALLOWLIST = process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS;

beforeEach(() => {
  delete process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS;
  dnsLookup.mockReset();
});

afterAll(() => {
  if (ORIGINAL_ALLOWLIST === undefined) {
    delete process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS;
  } else {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = ORIGINAL_ALLOWLIST;
  }
});

describe('checkWebhookUrl — accepted public URLs', () => {
  it('accepts a plain https URL', () => {
    expect(checkWebhookUrl('https://example.com/hook')).toEqual({ ok: true });
  });

  it('accepts a multi-label public hostname with query string', () => {
    expect(checkWebhookUrl('http://hooks.example.co.uk/x?y=1')).toEqual({ ok: true });
  });

  it('accepts a subdomain with a non-default port', () => {
    expect(checkWebhookUrl('https://sub.domain.example.com:8443/p')).toEqual({ ok: true });
  });
});

describe('checkWebhookUrl — loopback rejections', () => {
  it.each([
    'http://localhost:3000/x',
    'http://127.0.0.1/x',
    'http://127.1.2.3/x',
    'https://foo.localhost/x',
    'http://0.0.0.0/x',
    'http://[::1]/x',
  ])('rejects %s as loopback', (url) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('loopback');
  });
});

describe('checkWebhookUrl — private address rejections', () => {
  it.each([
    'http://10.1.2.3/x',
    'http://172.16.5.4/x',
    'http://172.31.255.1/x',
    'http://192.168.0.7/x',
    'http://[fc00::1]/x',
  ])('rejects %s as private_address', (url) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private_address');
  });
});

describe('checkWebhookUrl — link-local rejections', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[fe80::1]/x',
  ])('rejects %s as link_local', (url) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('link_local');
  });
});

describe('checkWebhookUrl — non-public (Docker service) hostname rejections', () => {
  it.each([
    'http://docuridge_postgres:5432/',
    'http://docuridge_mailhog:8025/',
    'http://redis/',
  ])('rejects %s as non_public_hostname', (url) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('non_public_hostname');
  });
});

describe('checkWebhookUrl — bad scheme rejections', () => {
  it.each([
    'ftp://example.com/x',
    'file:///etc/passwd',
  ])('rejects %s as bad_scheme', (url) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_scheme');
  });
});

describe('checkWebhookUrl — invalid URL rejections', () => {
  it.each([
    'not-a-url',
    '',
  ])('rejects %j as invalid_url', (url) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_url');
  });
});

describe('checkWebhookUrl — near-miss ranges that must NOT be rejected', () => {
  it.each([
    'http://110.0.0.1/x',
    'http://172.32.0.1/x',
    'http://192.169.0.1/x',
    'http://11.0.0.1/x',
  ])('accepts %s (not actually in a private range)', (url) => {
    expect(checkWebhookUrl(url)).toEqual({ ok: true });
  });
});

describe('checkWebhookUrl — WEBHOOK_ALLOWED_INTERNAL_HOSTS opt-in', () => {
  it('accepts an allowlisted internal hostname', () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = 'docuridge_postgres';
    expect(checkWebhookUrl('http://docuridge_postgres:5432/')).toEqual({ ok: true });
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = '  DocuRidge_Postgres , redis ';
    expect(checkWebhookUrl('http://docuridge_postgres:5432/')).toEqual({ ok: true });
    expect(checkWebhookUrl('http://REDIS/')).toEqual({ ok: true });
  });

  it('treats an empty allowlist as no exemptions, not a wildcard', () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = '';
    const result = checkWebhookUrl('http://localhost/x');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('loopback');
  });

  it('treats a whitespace-only allowlist as no exemptions, not a wildcard', () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = '   ';
    const result = checkWebhookUrl('http://localhost/x');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('loopback');
  });

  it('does not exempt hosts absent from the allowlist', () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = 'docuridge_postgres';
    const result = checkWebhookUrl('http://redis/');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('non_public_hostname');
  });
});

describe('checkWebhookUrl — rejection messages', () => {
  it('provides an operator-facing message for every rejection', () => {
    const rejections = [
      'http://localhost/x',
      'http://10.0.0.1/x',
      'http://169.254.169.254/x',
      'http://redis/',
      'ftp://example.com/x',
      'not-a-url',
    ];
    for (const url of rejections) {
      const result = checkWebhookUrl(url);
      expect(result.ok).toBe(false);
      expect(result.message).toBeTruthy();
      expect(typeof result.message).toBe('string');
    }
  });
});

describe('checkWebhookUrl — IPv4-mapped / embedded IPv6 literals', () => {
  it.each([
    ['http://[::ffff:127.0.0.1]/', 'loopback'],
    ['http://[::ffff:7f00:1]/', 'loopback'],
    ['http://[::ffff:172.18.0.2]/', 'private_address'],
    ['http://[::ffff:169.254.169.254]/', 'link_local'],
    ['http://[::]/', 'loopback'],
    ['http://[::127.0.0.1]/', 'loopback'],
    ['http://[64:ff9b::7f00:1]/', 'loopback'],
    ['http://[::ffff:172.18.0.3]:8025/api/v2/jim', 'private_address'],
  ])('rejects %s as %s', (url, reason) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it('still accepts a global IPv6 literal', () => {
    expect(checkWebhookUrl('https://[2606:4700:4700::1111]/hook')).toEqual({ ok: true });
  });
});

describe('checkWebhookUrl — names that only make sense inside the network', () => {
  it.each([
    'http://docuridge_mailhog.docuridge_internal:8025/api/v2/jim',
    'http://docuridge_mailhog.:8025/',
    'http://hooks.example.com./x',
  ])('rejects %s as non_public_hostname', (url) => {
    const result = checkWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('non_public_hostname');
  });
});

describe('vetWebhookUrl — resolves the hostname (DNS mocked)', () => {
  it('accepts a public name that resolves to public addresses', async () => {
    dnsLookup.mockResolvedValue(answer('93.184.215.14'));
    const result = await vetWebhookUrl('https://hooks.example.com/x');
    expect(result).toEqual({ ok: true });
    expect(dnsLookup).toHaveBeenCalledWith('hooks.example.com', expect.objectContaining({ all: true }));
  });

  it.each([
    ['http://10.0.0.1.nip.io/', ['10.0.0.1'], 'private_address'],
    ['http://127.0.0.1.sslip.io/', ['127.0.0.1'], 'loopback'],
    ['http://attacker.example.com/', ['172.18.0.3'], 'private_address'],
    ['http://attacker.example.com/', ['::ffff:a9fe:a9fe'], 'link_local'],
    ['http://attacker.example.com/', ['93.184.215.14', '192.168.1.1'], 'private_address'],
  ])('rejects %s resolving to %j as %s', async (url, addresses, reason) => {
    dnsLookup.mockResolvedValue(answer(...addresses));
    const result = await vetWebhookUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.message).toBeTruthy();
  });

  it('rejects a hostname that does not resolve', async () => {
    dnsLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const result = await vetWebhookUrl('https://nowhere.example.com/');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unresolvable');
    expect(result.message).toBeTruthy();
  });

  it('refuses Docker-style names without looking them up', async () => {
    const result = await vetWebhookUrl('http://docuridge_mailhog.docuridge_internal:8025/');
    expect(result.reason).toBe('non_public_hostname');
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('honours WEBHOOK_ALLOWED_INTERNAL_HOSTS for a name that resolves internally', async () => {
    process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS = 'receiver.example.com';
    dnsLookup.mockResolvedValue(answer('10.0.0.9'));
    expect(await vetWebhookUrl('http://receiver.example.com/hook')).toEqual({ ok: true });
  });
});

describe('vetWebhookUrl — one message for every address refusal (no DNS oracle)', () => {
  it('SECURITY: unresolvable and every non-public answer share the same message', async () => {
    const messages = new Set<string | undefined>();
    const reasons = new Set<string | undefined>();
    dnsLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    let r = await vetWebhookUrl('https://nowhere.example.com/');
    messages.add(r.message);
    reasons.add(r.reason);
    for (const addr of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '240.0.0.1', '::1']) {
      dnsLookup.mockResolvedValue(answer(addr));
      r = await vetWebhookUrl('https://guessed.example.com/');
      expect(r.ok).toBe(false);
      messages.add(r.message);
      reasons.add(r.reason);
    }
    expect([...messages]).toEqual([WEBHOOK_TARGET_REFUSED_MESSAGE]);
    // The specific reason is still available to the caller for server logs.
    expect(reasons.size).toBeGreaterThan(1);
  });
});
