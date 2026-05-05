import { OrgRole } from '@prisma/client';

/**
 * Centralized authorization. Every Server Action and route handler MUST call
 * `can()` before mutating state or returning a resource. No inline role checks.
 *
 * The function is intentionally simple: a role × action matrix plus
 * resource-ownership rules. Resource-level checks (envelope ownership, org
 * membership) are inlined where the resource is loaded.
 */

export interface AuthnContext {
  userId: string;
  orgId: string;
  role: OrgRole;
}

export type Action =
  // Envelope lifecycle
  | 'envelope:create'
  | 'envelope:read'
  | 'envelope:update'
  | 'envelope:send'
  | 'envelope:void'
  | 'envelope:delete'
  | 'envelope:download_sealed'
  | 'envelope:audit_view'
  // Templates
  | 'template:create'
  | 'template:read'
  | 'template:update'
  | 'template:delete'
  | 'template:instantiate'
  // Bulk send
  | 'bulksend:create'
  | 'bulksend:read'
  | 'bulksend:cancel'
  // Org administration
  | 'org:read_settings'
  | 'org:update_settings'
  | 'org:invite_member'
  | 'org:remove_member'
  | 'org:read_audit'
  // Account
  | 'account:read_own'
  | 'account:update_own'
  | 'account:change_password';

export interface Resource {
  /**
   * Org of the resource. Cross-org access is always denied. The caller is
   * expected to load the resource scoped to ctx.orgId; this is a defense in
   * depth check.
   */
  orgId: string;
  /** For envelopes/templates/etc., the user that created the resource. */
  createdById?: string;
}

const PERMISSIONS: Record<Action, OrgRole[]> = {
  // Envelopes
  'envelope:create': ['ADMIN', 'SENDER'],
  'envelope:read': ['ADMIN', 'SENDER', 'VIEWER'],
  'envelope:update': ['ADMIN', 'SENDER'],
  'envelope:send': ['ADMIN', 'SENDER'],
  'envelope:void': ['ADMIN', 'SENDER'],
  'envelope:delete': ['ADMIN'],
  'envelope:download_sealed': ['ADMIN', 'SENDER', 'VIEWER'],
  'envelope:audit_view': ['ADMIN', 'SENDER', 'VIEWER'],

  // Templates
  'template:create': ['ADMIN', 'SENDER'],
  'template:read': ['ADMIN', 'SENDER', 'VIEWER'],
  'template:update': ['ADMIN', 'SENDER'],
  'template:delete': ['ADMIN'],
  'template:instantiate': ['ADMIN', 'SENDER'],

  // Bulk send
  'bulksend:create': ['ADMIN', 'SENDER'],
  'bulksend:read': ['ADMIN', 'SENDER', 'VIEWER'],
  'bulksend:cancel': ['ADMIN', 'SENDER'],

  // Org admin
  'org:read_settings': ['ADMIN', 'SENDER', 'VIEWER'],
  'org:update_settings': ['ADMIN'],
  'org:invite_member': ['ADMIN'],
  'org:remove_member': ['ADMIN'],
  'org:read_audit': ['ADMIN'],

  // Account self-management — every authenticated user can manage own account.
  'account:read_own': ['ADMIN', 'SENDER', 'VIEWER'],
  'account:update_own': ['ADMIN', 'SENDER', 'VIEWER'],
  'account:change_password': ['ADMIN', 'SENDER', 'VIEWER'],
};

export function can(ctx: AuthnContext, action: Action, resource?: Resource): boolean {
  const allowedRoles = PERMISSIONS[action];
  if (!allowedRoles.includes(ctx.role)) return false;

  if (resource) {
    // Cross-org access is always forbidden, regardless of role.
    if (resource.orgId !== ctx.orgId) return false;

    // SENDER can void/delete only their own envelopes; ADMIN can void/delete any
    // within the org. (Read/audit/download are role-gated above; ownership not
    // additionally required.)
    if (action === 'envelope:void' && ctx.role === 'SENDER') {
      return resource.createdById === ctx.userId;
    }
  }

  return true;
}

/** Throws AuthorizationError if `can()` returns false. */
export function authorize(
  ctx: AuthnContext,
  action: Action,
  resource?: Resource,
): void {
  if (!can(ctx, action, resource)) {
    throw new AuthorizationError(action, ctx, resource);
  }
}

export class AuthorizationError extends Error {
  readonly action: Action;
  readonly ctx: AuthnContext;
  readonly resource?: Resource;
  constructor(action: Action, ctx: AuthnContext, resource?: Resource) {
    super(`Forbidden: ${action} (role=${ctx.role})`);
    this.name = 'AuthorizationError';
    this.action = action;
    this.ctx = ctx;
    this.resource = resource;
  }
}
