import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { checkWebhookUrl } from './url-guard';

const ORIGINAL_ALLOWLIST = process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS;

beforeEach(() => {
  delete process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS;
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
