import { prisma } from '../prisma';
import { childLogger } from '../logger';

export type UserSecurityEventType =
  | 'login_succeeded'
  | 'login_failed'
  | 'lockout_triggered'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'email_verified'
  | 'session_revoked'
  | 'register_succeeded'
  | 'bootstrap_completed';

interface RecordArgs {
  userId: string;
  type: UserSecurityEventType;
  ipAddress?: string;
  userAgent?: string;
  data?: Record<string, unknown>;
}

/**
 * Append a user-security event. Best-effort — failures are logged but do not
 * break the auth path. Distinct from envelope AuditEvent.
 */
export async function recordUserSecurityEvent(args: RecordArgs): Promise<void> {
  try {
    await prisma.userSecurityAuditEvent.create({
      data: {
        userId: args.userId,
        type: args.type,
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
        data: args.data ? (args.data as object) : undefined,
      },
    });
  } catch (err) {
    childLogger({ module: 'audit-user-security' }).error(
      { err: err instanceof Error ? err.message : String(err), type: args.type, userId: args.userId },
      'failed to record user security event',
    );
  }
}
