import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../prisma';
import type { AuthnContext } from '../authz/can';

/**
 * REST API v1 bearer-token authentication.
 *
 * Token format: `dr_` + 32 url-safe random characters. Only the SHA-256 hex
 * of the plaintext is persisted (`ApiToken.tokenHash`), so a DB leak does not
 * leak usable tokens. Lookup is by exact hash — user input never reaches a
 * timing-sensitive comparison.
 *
 * The org is always pinned from the token row: clients can never select a
 * different org via query params or path manipulation.
 */

export interface ApiTokenPrincipal {
  id: string;
  orgId: string;
  userId: string;
  scopes: string[];
}

export type ApiAuthResult =
  | { ok: true; token: ApiTokenPrincipal }
  | { ok: false; status: 401 | 403; error: string };

/** Don't write lastUsedAt more than once per minute per token. */
const LAST_USED_TOUCH_MS = 60_000;

const TOKEN_RE = /^dr_[A-Za-z0-9_-]{32}$/;

function parseScopes(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Authenticate a request carrying `Authorization: Bearer dr_…`. Returns the
 * token principal on success; a 401-shaped error for missing/malformed,
 * unknown, revoked, or expired tokens.
 */
export async function authenticateApiRequest(req: Request): Promise<ApiAuthResult> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  const presented = match?.[1]?.trim() ?? '';
  if (!TOKEN_RE.test(presented)) {
    return { ok: false, status: 401, error: 'Missing or malformed bearer token.' };
  }

  const tokenHash = createHash('sha256').update(presented).digest('hex');
  const row = await prisma.apiToken.findUnique({ where: { tokenHash } });
  if (!row) return { ok: false, status: 401, error: 'Invalid API token.' };
  if (row.revokedAt) return { ok: false, status: 401, error: 'API token has been revoked.' };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 401, error: 'API token has expired.' };
  }

  // Throttled last-used touch: keeps the value fresh for the admin UI without
  // a DB write on every single request.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_TOUCH_MS) {
    await prisma.apiToken.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
  }

  return {
    ok: true,
    token: {
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      scopes: parseScopes(row.scopes),
    },
  };
}

export type ApiScopeError = { status: 403; error: string } | null;

/**
 * Enforce a scope on an authenticated principal. Returns a 403-shaped error
 * when the scope is missing, null otherwise.
 */
export function requireScope(
  auth: Extract<ApiAuthResult, { ok: true }>,
  scope: 'read' | 'write',
): ApiScopeError {
  if (!auth.token.scopes.includes(scope)) {
    return { status: 403, error: `This API token does not have the "${scope}" scope.` };
  }
  return null;
}

/**
 * Resolve the token creator's org membership into an AuthnContext so route
 * handlers can reuse the centralized `authorize()` matrix with a synthetic
 * context (mirroring the sealed-download semantics). Null when the creator
 * is no longer a member of the org.
 */
export async function resolveApiActor(orgId: string, userId: string): Promise<AuthnContext | null> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true },
  });
  if (!member) return null;
  return { userId, orgId, role: member.role };
}

export interface GeneratedApiToken {
  /** The plaintext token to show the admin exactly once — never persist. */
  plaintext: string;
  /** SHA-256 hex of the plaintext — this is what goes into the DB. */
  tokenHash: string;
}

/**
 * Generate a fresh API token: `dr_` + 32 url-safe random characters
 * (24 random bytes, base64url-encoded without padding).
 */
export function generateApiToken(): GeneratedApiToken {
  const plaintext = `dr_${randomBytes(24).toString('base64url')}`;
  return {
    plaintext,
    tokenHash: createHash('sha256').update(plaintext).digest('hex'),
  };
}
