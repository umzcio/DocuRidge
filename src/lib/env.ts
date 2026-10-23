import { z } from 'zod';
import { parseSsoIssuerBindings } from './auth/sso-bindings';

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
  /**
   * Set to 'true' ONLY to talk to a relay presenting a self-signed or
   * otherwise unverifiable certificate. Outbound mail carries signing links
   * that authorize signing as a recipient, so disabling verification exposes
   * them to anyone on the path between the app and the relay.
   */
  SMTP_RELAY_ALLOW_INVALID_CERT: z.enum(['true', 'false']).default('false'),
  MAIL_FROM_DEFAULT: z.string().default('DocuRidge <docuridge@example.com>'),
  /**
   * Comma-separated list of recipient email addresses that may receive real
   * outbound mail when MAIL_BACKEND=smtp_relay. The code-level safety net
   * (`isAllowedRecipient`) reads this once at module load. Empty list →
   * nothing sends, even if a valid backend is configured. To remove the
   * allowlist gate entirely, see DEPLOYMENT.md.
   */
  MAIL_ALLOWLIST: z.string().default(''),

  /**
   * Comma-separated hostnames that may receive webhooks despite resolving to
   * a private, loopback, or link-local address. Empty by default: webhook URLs
   * are admin-supplied and the app sits on a Docker network with Postgres and
   * MailHog, so an unrestricted target turns the dispatcher into an internal
   * port scanner. Add a host only when you deliberately webhook to a service
   * on your own network.
   */
  WEBHOOK_ALLOWED_INTERNAL_HOSTS: z.string().default(''),

  /**
   * Operator-set SSO bindings: comma-separated `<org-slug>=<issuer-url>`
   * entries, the issuer exactly as entered in that org's SSO settings. Org
   * admins choose their own issuer and SSO trusts its email claim, so SSO
   * runs only for an org whose (slug, issuer) pair is listed here — trusting
   * an issuer for every org would let any self-registered admin capture a
   * trusted IdP's users. A malformed entry (no `=`, empty slug, non-https
   * issuer, slug listed twice) halts boot. Empty disables SSO.
   */
  SSO_TRUSTED_ISSUERS: z
    .string()
    .default('')
    .superRefine((raw, ctx) => {
      for (const { entry, reason } of parseSsoIssuerBindings(raw).invalid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid entry "${entry}": ${reason}` });
      }
    }),

  SESSION_SECRET: z.string().min(32),
  JWS_SIGNING_TOKEN_SECRET: z.string().min(32),
  JWS_RESET_TOKEN_SECRET: z.string().min(32),

  BOOTSTRAP_TOKEN: z.string().min(16),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  BOOTSTRAP_ADMIN_NAME: z.string().default('DocuRidge Admin'),
  BOOTSTRAP_ORG_NAME: z.string().default('Acme Org'),
  BOOTSTRAP_ORG_SLUG: z.string().default('acme'),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  /**
   * Minimum seconds between `Session.lastSeenAt` writes. getSession() is called
   * many times per request, and the timestamp is only used for operator
   * visibility, so writing it on every read costs WAL and dead tuples for no
   * benefit. 0 disables throttling (write every time).
   */
  SESSION_HEARTBEAT_SECONDS: z.coerce.number().int().min(0).default(60),

  /**
   * Minimum minutes between opportunistic prunes of expired rate-limit buckets.
   * The table is insert-only on every rate-limited request, so without this it
   * grows without bound.
   */
  RATELIMIT_CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),

  LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOCKOUT_DURATION_MINUTES: z.coerce.number().int().positive().default(15),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),

  /**
   * Number of trusted reverse proxies in front of the app. The client IP is
   * taken this many entries from the RIGHT of X-Forwarded-For, because the
   * deployed nginx appends with $proxy_add_x_forwarded_for — anything further
   * left was supplied by the client and is forgeable.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).default(1),

  RL_LOGIN_PER_MIN: z.coerce.number().int().positive().default(10),
  /**
   * Login attempts per minute against one email address, whatever the source
   * address. The per-IP limit alone does not bound guesses from many IPs.
   */
  RL_LOGIN_ACCOUNT_PER_MIN: z.coerce.number().int().positive().default(10),
  RL_REGISTER_PER_MIN: z.coerce.number().int().positive().default(5),
  RL_PASSWORD_RESET_PER_MIN: z.coerce.number().int().positive().default(3),
  RL_SIGNING_TOKEN_PER_MIN: z.coerce.number().int().positive().default(30),
  RL_SHARE_VIEW_PER_MIN: z.coerce.number().int().positive().default(20),

  /**
   * Minutes during which repeat views of the same share link update the view
   * counter WITHOUT appending another audit-chain event. The chain is
   * append-only and Ed25519-signed per event, and the share page is
   * unauthenticated, so one event per window keeps the trail readable and
   * bounds the cost of a refresh loop.
   */
  SHARE_VIEW_AUDIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  UPLOADS_DIR: z.string().default('/data/uploads'),
  SEALED_DIR: z.string().default('/data/sealed'),
  ATTACHMENTS_DIR: z.string().default('/data/attachments'),
  KEYS_DIR: z.string().default('/data/keys'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26214400),
  /**
   * Ceilings on bytes inflated from a PDF's compressed streams: per stream, and
   * across one parse/seal step. MAX_UPLOAD_BYTES bounds only the encoded size,
   * and nested FlateDecode amplifies it a millionfold. Read directly by
   * `src/lib/pdf/decode-limits.ts` (also used by scripts/verify.ts).
   */
  PDF_MAX_DECODED_STREAM_BYTES: z.coerce.number().int().positive().default(67108864),
  PDF_MAX_DECODED_TOTAL_BYTES: z.coerce.number().int().positive().default(268435456),
  /** Per-attachment cap for recipient-uploaded files (default 10 MB). */
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(10485760),
  /**
   * Per-signature cap on the decoded PNG a recipient may adopt (default 2 MB).
   * The value is persisted as base64 text and re-embedded on every seal, so an
   * uncapped image inflates both the row and the sealed PDF.
   */
  MAX_SIGNATURE_IMAGE_BYTES: z.coerce.number().int().positive().default(2097152),
  /**
   * Ceilings on the dimensions an embedded image may declare in its PNG IHDR
   * or JPEG SOF header (signature, initials, DRAWING, STAMP). pdf-lib's decode
   * cost follows the declared size, so the encoded-byte cap alone does not
   * bound memory. Read directly by `src/lib/signing/signature-image.ts`.
   */
  MAX_IMAGE_DIMENSION: z.coerce.number().int().positive().default(4096),
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(8388608),
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
