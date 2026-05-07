import { z } from 'zod';

/**
 * Environment validation. Failures here halt boot — better than a 500 mid-flow.
 * Secrets that the entrypoint script generates if blank (SESSION_SECRET,
 * JWS_*_SECRET, BOOTSTRAP_TOKEN) are required to be present by the time the
 * app process starts; the entrypoint enforces that.
 */
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),

  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),

  MAIL_BACKEND: z.enum(['mailhog', 'smtp_relay']).default('mailhog'),
  MAILHOG_HOST: z.string().default('docuridge_mailhog'),
  MAILHOG_PORT: z.coerce.number().int().positive().default(1025),
  /** Hostname of the production SMTP relay (your org's mail server). */
  SMTP_RELAY_HOST: z.string().default(''),
  SMTP_RELAY_PORT: z.coerce.number().int().positive().default(25),
  MAIL_FROM_DEFAULT: z.string().default('DocuRidge <docuridge@example.com>'),
  /**
   * Comma-separated list of recipient email addresses that may receive real
   * outbound mail when MAIL_BACKEND=smtp_relay. The code-level safety net
   * (`isAllowedRecipient`) reads this once at module load. Empty list →
   * nothing sends, even if a valid backend is configured. To remove the
   * allowlist gate entirely, see DEPLOYMENT.md.
   */
  MAIL_ALLOWLIST: z.string().default(''),

  SESSION_SECRET: z.string().min(32),
  JWS_SIGNING_TOKEN_SECRET: z.string().min(32),
  JWS_RESET_TOKEN_SECRET: z.string().min(32),

  BOOTSTRAP_TOKEN: z.string().min(16),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  BOOTSTRAP_ADMIN_NAME: z.string().default('DocuRidge Admin'),
  BOOTSTRAP_ORG_NAME: z.string().default('Acme Org'),
  BOOTSTRAP_ORG_SLUG: z.string().default('acme'),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOCKOUT_DURATION_MINUTES: z.coerce.number().int().positive().default(15),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),

  RL_LOGIN_PER_MIN: z.coerce.number().int().positive().default(10),
  RL_REGISTER_PER_MIN: z.coerce.number().int().positive().default(5),
  RL_PASSWORD_RESET_PER_MIN: z.coerce.number().int().positive().default(3),
  RL_SIGNING_TOKEN_PER_MIN: z.coerce.number().int().positive().default(30),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  UPLOADS_DIR: z.string().default('/data/uploads'),
  SEALED_DIR: z.string().default('/data/sealed'),
  ATTACHMENTS_DIR: z.string().default('/data/attachments'),
  KEYS_DIR: z.string().default('/data/keys'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26214400),
  /** Per-attachment cap for recipient-uploaded files (default 10 MB). */
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(10485760),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** The public origin (no path), used for CSRF origin checks. */
export function getPublicOrigin(): string {
  const url = new URL(getEnv().PUBLIC_URL);
  return `${url.protocol}//${url.host}`;
}

/** The public basePath portion (e.g. "/DocuRidge"). */
export function getBasePath(): string {
  const url = new URL(getEnv().PUBLIC_URL);
  return url.pathname.replace(/\/$/, '');
}
