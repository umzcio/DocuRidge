import nodemailer, { Transporter } from 'nodemailer';
import { getEnv } from '../env';
import { childLogger } from '../logger';
import { AllowlistRefusalError, isAllowedRecipient } from './allowlist';
import { prisma } from '../prisma';

export interface SendArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Optional org id — recorded on the EmailEvent row for traceability. */
  orgId?: string;
  /** Optional envelope id — recorded on the EmailEvent row. */
  envelopeId?: string;
  /** Optional recipient id — recorded on the EmailEvent row. */
  recipientId?: string;
}

export interface SendResult {
  delivered: boolean;
  /** True iff the SMTP relay allowlist gate refused the recipient. */
  refusedByAllowlist: boolean;
  messageId?: string;
}

let cachedTransport: Transporter | null = null;

function getTransport(): Transporter {
  if (cachedTransport) return cachedTransport;
  const env = getEnv();
  if (env.MAIL_BACKEND === 'mailhog') {
    cachedTransport = nodemailer.createTransport({
      host: env.MAILHOG_HOST,
      port: env.MAILHOG_PORT,
      secure: false,
      // MailHog has no auth.
    });
  } else {
    cachedTransport = nodemailer.createTransport({
      host: env.SMTP_RELAY_HOST,
      port: env.SMTP_RELAY_PORT,
      secure: false,
      tls: { rejectUnauthorized: false },
    });
  }
  return cachedTransport;
}

/**
 * Send an email through the configured backend.
 *
 * For MAIL_BACKEND=smtp_relay, the recipient address passes through
 * isAllowedRecipient(). Refusal:
 *   1. Does NOT send.
 *   2. Logs a structured warning.
 *   3. Records an EmailEvent row with type='skipped_allowlist'.
 *   4. Throws AllowlistRefusalError when NODE_ENV !== 'production'.
 *      In production, returns { delivered: false, refusedByAllowlist: true }
 *      so callers can surface the refusal without crashing.
 *
 * For MAIL_BACKEND=mailhog, the allowlist is not consulted (it's a dev sink).
 */
export async function sendMail(args: SendArgs): Promise<SendResult> {
  const env = getEnv();
  const log = childLogger({ module: 'mail', backend: env.MAIL_BACKEND });

  const allowlistActive = env.MAIL_BACKEND === 'smtp_relay';

  if (allowlistActive && !isAllowedRecipient(args.to)) {
    log.warn(
      { to: args.to, subject: args.subject, orgId: args.orgId },
      'allowlist refusal — non-allowlisted recipient blocked from SMTP relay',
    );
    await recordEmailEvent({
      orgId: args.orgId,
      envelopeId: args.envelopeId,
      recipientId: args.recipientId,
      type: 'skipped_allowlist',
      toAddress: args.to,
      subject: args.subject,
      error: 'recipient not on allowlist',
    });
    if (env.NODE_ENV !== 'production') {
      throw new AllowlistRefusalError(args.to);
    }
    return { delivered: false, refusedByAllowlist: true };
  }

  try {
    const transport = getTransport();
    const info = await transport.sendMail({
      from: env.MAIL_FROM_DEFAULT,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    log.info(
      { to: args.to, subject: args.subject, messageId: info.messageId, orgId: args.orgId },
      'mail sent',
    );
    await recordEmailEvent({
      orgId: args.orgId,
      envelopeId: args.envelopeId,
      recipientId: args.recipientId,
      type: 'sent',
      toAddress: args.to,
      subject: args.subject,
      messageId: info.messageId,
    });
    return { delivered: true, refusedByAllowlist: false, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ to: args.to, subject: args.subject, err: message }, 'mail send failed');
    await recordEmailEvent({
      orgId: args.orgId,
      envelopeId: args.envelopeId,
      recipientId: args.recipientId,
      type: 'failed',
      toAddress: args.to,
      subject: args.subject,
      error: message,
    });
    return { delivered: false, refusedByAllowlist: false };
  }
}

interface EmailEventInsert {
  orgId?: string;
  envelopeId?: string;
  recipientId?: string;
  type: string;
  toAddress: string;
  subject?: string;
  messageId?: string;
  error?: string;
}

async function recordEmailEvent(input: EmailEventInsert): Promise<void> {
  // The EmailEvent table requires orgId. If we don't have one (e.g., bootstrap
  // password reset before any org is bound), skip persistence; the log line
  // above carries the relevant signal.
  if (!input.orgId) return;
  try {
    await prisma.emailEvent.create({
      data: {
        orgId: input.orgId,
        envelopeId: input.envelopeId ?? null,
        recipientId: input.recipientId ?? null,
        type: input.type,
        toAddress: input.toAddress,
        subject: input.subject ?? null,
        messageId: input.messageId ?? null,
        error: input.error ?? null,
      },
    });
  } catch (err) {
    // Email-event recording must not block the actual send outcome.
    childLogger({ module: 'mail' }).error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to record email event',
    );
  }
}

export { isAllowedRecipient } from './allowlist';
