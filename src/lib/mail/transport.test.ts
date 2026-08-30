import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getTransport() is module-private (src/lib/mail/index.ts). We exercise it
// through its only observable effect — the options object it hands to
// nodemailer.createTransport — by mocking nodemailer and inspecting the call.
const createTransport = vi.fn((_options?: unknown) => ({
  sendMail: vi.fn().mockResolvedValue({ messageId: 'test' }),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

const REQUIRED_ENV = {
  PUBLIC_URL: 'https://test.example/DocuRidge',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  SESSION_SECRET: 'x'.repeat(32),
  JWS_SIGNING_TOKEN_SECRET: 'y'.repeat(32),
  JWS_RESET_TOKEN_SECRET: 'z'.repeat(32),
  BOOTSTRAP_TOKEN: 'abcdefghijklmnop',
  NODE_ENV: 'test',
} as const;

// isAllowedRecipient() reads MAIL_ALLOWLIST at module load (src/lib/mail/allowlist.ts).
// Seed the recipient we'll send to so sendMail() doesn't short-circuit before
// ever constructing a transport.
const ALLOWED_RECIPIENT = 'allowed@example.com';

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
  process.env.MAIL_ALLOWLIST = ALLOWED_RECIPIENT;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const ENV_KEYS_TO_CLEAR = [
  ...Object.keys(REQUIRED_ENV),
  'MAIL_ALLOWLIST',
  'MAIL_BACKEND',
  'SMTP_RELAY_HOST',
  'SMTP_RELAY_ALLOW_INVALID_CERT',
];

beforeEach(() => {
  createTransport.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS_TO_CLEAR) {
    delete process.env[key];
  }
  vi.resetModules();
});

describe('SMTP relay transport TLS options', () => {
  it('REGRESSION GUARD: verifies the relay certificate by default (SMTP_RELAY_ALLOW_INVALID_CERT unset)', async () => {
    vi.resetModules();
    setEnv({
      MAIL_BACKEND: 'smtp_relay',
      SMTP_RELAY_HOST: 'relay.example.com',
      // SMTP_RELAY_ALLOW_INVALID_CERT intentionally unset.
    });

    const { sendMail } = await import('./index');
    await sendMail({ to: ALLOWED_RECIPIENT, subject: 'hi', text: 'body' });

    expect(createTransport).toHaveBeenCalledTimes(1);
    const options = createTransport.mock.calls[0]?.[0] as unknown as {
      tls?: { rejectUnauthorized?: boolean };
      requireTLS?: boolean;
    };
    expect(options.tls?.rejectUnauthorized).toBe(true);
    expect(options.requireTLS).toBe(true);
  });

  it('verifies the relay certificate when SMTP_RELAY_ALLOW_INVALID_CERT is explicitly false', async () => {
    vi.resetModules();
    setEnv({
      MAIL_BACKEND: 'smtp_relay',
      SMTP_RELAY_HOST: 'relay.example.com',
      SMTP_RELAY_ALLOW_INVALID_CERT: 'false',
    });

    const { sendMail } = await import('./index');
    await sendMail({ to: ALLOWED_RECIPIENT, subject: 'hi', text: 'body' });

    const options = createTransport.mock.calls[0]?.[0] as unknown as {
      tls?: { rejectUnauthorized?: boolean };
      requireTLS?: boolean;
    };
    expect(options.tls?.rejectUnauthorized).toBe(true);
    expect(options.requireTLS).toBe(true);
  });

  it('disables certificate verification only when explicitly opted in', async () => {
    vi.resetModules();
    setEnv({
      MAIL_BACKEND: 'smtp_relay',
      SMTP_RELAY_HOST: 'relay.example.com',
      SMTP_RELAY_ALLOW_INVALID_CERT: 'true',
    });

    const { sendMail } = await import('./index');
    await sendMail({ to: ALLOWED_RECIPIENT, subject: 'hi', text: 'body' });

    const options = createTransport.mock.calls[0]?.[0] as unknown as {
      tls?: { rejectUnauthorized?: boolean };
    };
    expect(options.tls?.rejectUnauthorized).toBe(false);
  });

  it('leaves the MailHog dev branch untouched (no rejectUnauthorized: false)', async () => {
    vi.resetModules();
    setEnv({
      MAIL_BACKEND: 'mailhog',
    });

    const { sendMail } = await import('./index');
    // MailHog doesn't consult the allowlist, so any recipient works.
    await sendMail({ to: 'anyone@example.com', subject: 'hi', text: 'body' });

    const options = createTransport.mock.calls[0]?.[0] as unknown as {
      tls?: { rejectUnauthorized?: boolean };
    };
    expect(options.tls?.rejectUnauthorized).not.toBe(false);
  });
});
