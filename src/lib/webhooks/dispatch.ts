/**
 * Outbound webhook dispatcher. Fire-and-forget HTTP POST to every active
 * org-scoped subscription on every audit event. Each delivery is signed
 * with HMAC-SHA256 over the JSON body using the subscription's `secret`,
 * surfaced in the `X-DocuRidge-Signature` header as `sha256=<hex>`. The
 * receiver verifies by re-computing the HMAC and constant-time comparing.
 *
 * Design choices:
 *   - No retry queue in v1 — failed deliveries are logged + counted on the
 *     subscription row. Receivers should be idempotent.
 *   - All-events subscription model (no per-event filtering yet) keeps the
 *     setup wizard one field. v1.1 can add the existing `events String[]`
 *     column to the picker.
 *   - 5s timeout via AbortController so a slow webhook doesn't pin a server
 *     action's lifetime.
 */
import { createHmac } from 'node:crypto';
import { prisma } from '../prisma';
import { childLogger } from '../logger';

const log = childLogger({ module: 'webhooks' });

export interface WebhookEvent {
  /** Audit-event type, e.g. 'envelope.completed', 'recipient.signed'. */
  type: string;
  envelopeId: string;
  orgId: string;
  occurredAt: Date;
  /** Free-form event-specific payload mirrored from the audit chain. */
  data?: Record<string, unknown>;
}

const TIMEOUT_MS = 5000;

/**
 * Fire-and-forget: schedules an HTTP POST to every active subscription in
 * the org but never awaits the network round-trip. Caller continues
 * immediately. Errors are caught and logged; failure counts are persisted
 * but don't bubble up to the caller.
 */
export function dispatchWebhooks(event: WebhookEvent): void {
  // Run async without awaiting — caller's request must not be slowed down
  // by a webhook receiver.
  void deliverAll(event).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'webhook dispatch failed');
  });
}

async function deliverAll(event: WebhookEvent): Promise<void> {
  const subs = await prisma.webhookSubscription.findMany({
    where: { orgId: event.orgId, enabled: true },
  });
  if (subs.length === 0) return;

  const body = JSON.stringify({
    event: event.type,
    envelopeId: event.envelopeId,
    occurredAt: event.occurredAt.toISOString(),
    data: event.data ?? {},
  });

  await Promise.all(
    subs.map(async (sub) => {
      // Per-subscription event filter: empty array means "all events".
      if (sub.events.length > 0 && !sub.events.includes(event.type)) return;
      const signature = createHmac('sha256', sub.secret).update(body).digest('hex');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(sub.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'DocuRidge-Webhook/1',
            'x-docuridge-signature': `sha256=${signature}`,
            'x-docuridge-event': event.type,
            'x-docuridge-delivery': cryptoRandomDeliveryId(),
          },
          body,
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) {
          await markFailure(sub.id, `HTTP ${res.status}`);
          return;
        }
        // Success — clear any prior failure state and bump lastFiredAt-ish
        // tracking via attempts column.
        await prisma.webhookCall.create({
          data: {
            subscriptionId: sub.id,
            payload: { event: event.type, envelopeId: event.envelopeId },
            responseStatus: res.status,
            attempts: 1,
          },
        });
      } catch (err) {
        clearTimeout(t);
        await markFailure(sub.id, err instanceof Error ? err.message : String(err));
      }
    }),
  );
}

async function markFailure(subscriptionId: string, message: string) {
  log.warn({ subscriptionId, message }, 'webhook delivery failed');
  await prisma.webhookCall.create({
    data: {
      subscriptionId,
      payload: { error: message },
      responseStatus: null,
      attempts: 1,
    },
  }).catch(() => null);
}

function cryptoRandomDeliveryId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    // Node fallback — should be unreachable on the server, but keep safe.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
