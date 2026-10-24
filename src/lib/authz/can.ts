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
  /** Post-send correction (details, add/replace/remove pending recipients). */
  | 'envelope:correct'
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
  | 'account:change_password'
  // Folders (org-shared document organization)
  | 'folder:create'
  | 'folder:update'
  | 'folder:delete'
  | 'folder:assign_envelope'
  // Webhooks
  | 'webhook:read'
  | 'webhook:manage'
  // Public forms (PowerForms) — publishing mints an anonymous envelope-creating URL
  | 'template:publish_public_form';

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

export const PERMISSIONS: Record<Action, OrgRole[]> = {
  // Envelopes
  'envelope:create': ['ADMIN', 'SENDER'],
  'envelope:read': ['ADMIN', 'SENDER', 'VIEWER'],
  'envelope:update': ['ADMIN', 'SENDER'],
  'envelope:send': ['ADMIN', 'SENDER'],
  'envelope:void': ['ADMIN', 'SENDER'],
  // Correcting a sent envelope changes who signs it and when it expires, so
  // it is owner-scoped for SENDER exactly like void (see OWNER_SCOPED below).
  'envelope:correct': ['ADMIN', 'SENDER'],
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

  // Folders — shared org structure, so not writable by VIEWER.
  'folder:create': ['ADMIN', 'SENDER'],
  'folder:update': ['ADMIN', 'SENDER'],
  'folder:delete': ['ADMIN'],
  'folder:assign_envelope': ['ADMIN', 'SENDER'],

  // Webhooks — admin-only, matching the checks these replace.
  'webhook:read': ['ADMIN'],
  'webhook:manage': ['ADMIN'],

  // Publishing a public form exposes an anonymous envelope-creating URL, so it
  // is a send-grade capability, not a template edit.
  'template:publish_public_form': ['ADMIN', 'SENDER'],
};

/**
 * Actions a SENDER may perform only on resources they created; ADMIN may
 * perform them on any resource in the org. These change the fate of an
 * envelope someone else is responsible for, unlike read/audit/download
 * (role-gated only) or draft editing (org-shared, `envelope:update`).
 */
export const OWNER_SCOPED_FOR_SENDER: ReadonlySet<Action> = new Set<Action>([
  'envelope:void',
  'envelope:correct',
]);

export function can(ctx: AuthnContext, action: Action, resource?: Resource): boolean {
  const allowedRoles = PERMISSIONS[action];
  if (!allowedRoles.includes(ctx.role)) return false;

  if (OWNER_SCOPED_FOR_SENDER.has(action) && ctx.role === 'SENDER') {
    // Fail closed: an owner-scoped check without the resource's creator
    // cannot be answered, so it is refused rather than waved through.
    if (!resource?.createdById) return false;
    if (resource.createdById !== ctx.userId) return false;
  }

  // Cross-org access is always forbidden, regardless of role.
  if (resource && resource.orgId !== ctx.orgId) return false;

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
