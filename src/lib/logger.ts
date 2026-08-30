import pino from 'pino';

/**
 * Structured JSON logger. Every log line carries requestId / userId / orgId /
 * action / resource / outcome via child loggers attached in middleware.
 *
 * Redaction list covers known sensitive paths so a sloppy `logger.info({ user })`
 * cannot leak password hashes or tokens.
 */
const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'tokenHash',
  '*.tokenHash',
  'cookie',
  'authorization',
  'headers.cookie',
  'headers.authorization',
  'secret',
  '*.secret',
  'signingKey',
  '*.signingKey',
  'privateKey',
  '*.privateKey',
  'bootstrapToken',
  '*.bootstrapToken',
  'sessionId',
  '*.sessionId',
];

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return LOG_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : 'info';
}

let cached: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (cached) return cached;
  // Read the two vars the logger needs straight from process.env instead of
  // through the validated loader. Modules build loggers at import scope, so
  // going through the validated loader made merely IMPORTING them require
  // every secret to be present — which broke `next build` and is why a
  // populated .env had to be in the Docker build context. Same reasoning as
  // src/lib/mail/allowlist.ts.
  cached = pino({
    level: resolveLogLevel(),
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'docuridge', env: process.env.NODE_ENV ?? 'production' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return cached;
}

/** Convenience: a child logger bound to a request context. */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
