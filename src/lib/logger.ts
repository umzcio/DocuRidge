import pino from 'pino';
import { getEnv } from './env';

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

let cached: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (cached) return cached;
  const env = getEnv();
  cached = pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'docuridge', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return cached;
}

/** Convenience: a child logger bound to a request context. */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
