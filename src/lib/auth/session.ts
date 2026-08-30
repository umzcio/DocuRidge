import { cache } from 'react';
import { cookies } from 'next/headers';
import { prisma } from '../prisma';
import { getEnv, getBasePath } from '../env';
import { randomBase64Url, getClientIp } from '../util';
import { shouldWriteHeartbeat } from './heartbeat';
import type { OrgRole, User } from '@prisma/client';

const SESSION_COOKIE = 'docuridge_session';

export interface SessionInfo {
  sessionId: string;
  user: User;
  orgId: string;
  role: OrgRole;
}

/**
 * Create a session for `userId` bound to `orgId`. Sets the cookie scoped to
 * the basePath. Caller is responsible for headers (IP/UA capture).
 */
export async function createSession(args: {
  userId: string;
  orgId: string;
  ipAddress: string;
  userAgent: string;
}): Promise<string> {
  const env = getEnv();
  const sessionId = randomBase64Url(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      id: sessionId,
      userId: args.userId,
      orgId: args.orgId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      expiresAt,
    },
  });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: getBasePath() || '/',
    expires: expiresAt,
  });
  return sessionId;
}

/**
 * Per-request memo of the session row. React's cache() dedupes within a single
 * server request, so a layout + page + several server actions resolve one
 * session with one query instead of one each.
 */
const loadSessionRow = cache(async (sessionId: string) => {
  return prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        include: {
          memberships: { where: { orgId: { not: undefined } } },
        },
      },
    },
  });
});

/**
 * Per-request heartbeat guard. The memoized session row keeps its original
 * lastSeenAt, so without this every getSession() call in a request that is
 * due for a heartbeat would issue its own write.
 */
const writeHeartbeatOnce = cache(async (sessionId: string) => {
  // Best-effort: a missed heartbeat costs nothing, and a failed write must
  // not deny an otherwise valid session.
  await prisma.session
    .update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    })
    .catch(() => null);
});

/**
 * Resolve the current session, or null if there is none / it's expired /
 * revoked. Memoized per request. `lastSeenAt` is refreshed at most once per
 * SESSION_HEARTBEAT_SECONDS for operator visibility — it does NOT extend the
 * session; `expiresAt` is fixed at creation.
 */
export async function getSession(): Promise<SessionInfo | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const session = await loadSessionRow(sessionId);
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  if (session.user.deletedAt) return null;

  if (shouldWriteHeartbeat(session.lastSeenAt)) {
    await writeHeartbeatOnce(sessionId);
  }

  // Find the membership matching the session's recorded orgId.
  const membership = session.user.memberships.find((m) => m.orgId === session.orgId);
  if (!membership) return null;

  return {
    sessionId: session.id,
    user: session.user,
    orgId: session.orgId,
    role: membership.role,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * Revoke all active (non-revoked, non-expired) sessions for a user. Used on
 * password change and lockout.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Convenience: pull IP + UA from request headers for session creation. */
export function captureClientContext(headers: Headers): {
  ipAddress: string;
  userAgent: string;
} {
  return {
    ipAddress: getClientIp(headers),
    userAgent: headers.get('user-agent') ?? 'unknown',
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
