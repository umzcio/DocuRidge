import { describe, it, expect } from 'vitest';
import { OrgRole } from '@prisma/client';
import { can, authorize, AuthorizationError, PERMISSIONS, type AuthnContext, type Action } from './can';

const adminCtx: AuthnContext = { userId: 'u_admin', orgId: 'org_1', role: OrgRole.ADMIN };
const senderCtx: AuthnContext = { userId: 'u_sender', orgId: 'org_1', role: OrgRole.SENDER };
const viewerCtx: AuthnContext = { userId: 'u_viewer', orgId: 'org_1', role: OrgRole.VIEWER };

const ownEnv = { orgId: 'org_1', createdById: 'u_sender' };
const otherEnv = { orgId: 'org_1', createdById: 'u_someone_else' };
const crossOrgEnv = { orgId: 'org_2', createdById: 'u_sender' };

describe('can() — envelope permissions', () => {
  it('admin can do everything envelope-related', () => {
    expect(can(adminCtx, 'envelope:create')).toBe(true);
    expect(can(adminCtx, 'envelope:send')).toBe(true);
    expect(can(adminCtx, 'envelope:void', otherEnv)).toBe(true);
    expect(can(adminCtx, 'envelope:delete')).toBe(true);
  });

  it('sender can create, send, and void own envelopes', () => {
    expect(can(senderCtx, 'envelope:create')).toBe(true);
    expect(can(senderCtx, 'envelope:send')).toBe(true);
    expect(can(senderCtx, 'envelope:void', ownEnv)).toBe(true);
  });

  it('sender cannot void another user\'s envelope (ownership rule)', () => {
    expect(can(senderCtx, 'envelope:void', otherEnv)).toBe(false);
  });

  it('sender cannot delete envelopes (admin-only)', () => {
    expect(can(senderCtx, 'envelope:delete')).toBe(false);
    expect(can(senderCtx, 'envelope:delete', ownEnv)).toBe(false);
  });

  it('viewer can read but not create or modify', () => {
    expect(can(viewerCtx, 'envelope:read')).toBe(true);
    expect(can(viewerCtx, 'envelope:download_sealed')).toBe(true);
    expect(can(viewerCtx, 'envelope:create')).toBe(false);
    expect(can(viewerCtx, 'envelope:send')).toBe(false);
    expect(can(viewerCtx, 'envelope:void', ownEnv)).toBe(false);
  });
});

describe('can() — envelope:correct (post-send correction is owner-scoped for SENDER)', () => {
  it('sender can correct their own envelope', () => {
    expect(can(senderCtx, 'envelope:correct', ownEnv)).toBe(true);
  });

  it('SECURITY: sender cannot correct a colleague\'s envelope', () => {
    expect(can(senderCtx, 'envelope:correct', otherEnv)).toBe(false);
  });

  it('SECURITY: sender is refused when no resource is supplied (fails closed)', () => {
    expect(can(senderCtx, 'envelope:correct')).toBe(false);
    expect(can(senderCtx, 'envelope:correct', { orgId: 'org_1' })).toBe(false);
  });

  it('admin can correct any envelope in the org', () => {
    expect(can(adminCtx, 'envelope:correct', otherEnv)).toBe(true);
    expect(can(adminCtx, 'envelope:correct', crossOrgEnv)).toBe(false);
  });

  it('viewer cannot correct, even their own envelope', () => {
    expect(can(viewerCtx, 'envelope:correct', { orgId: 'org_1', createdById: 'u_viewer' })).toBe(false);
  });
});

describe('can() — cross-org access is always denied', () => {
  it.each<[string, AuthnContext, Action]>([
    ['admin', adminCtx, 'envelope:read'],
    ['admin', adminCtx, 'envelope:void'],
    ['admin', adminCtx, 'envelope:delete'],
    ['sender', senderCtx, 'envelope:read'],
    ['sender', senderCtx, 'envelope:void'],
    ['viewer', viewerCtx, 'envelope:read'],
    ['viewer', viewerCtx, 'envelope:download_sealed'],
  ])('%s denied cross-org access to %s', (_role, ctx, action) => {
    expect(can(ctx, action, crossOrgEnv)).toBe(false);
  });
});

describe('can() — templates', () => {
  it('admin can manage and instantiate', () => {
    expect(can(adminCtx, 'template:create')).toBe(true);
    expect(can(adminCtx, 'template:delete')).toBe(true);
    expect(can(adminCtx, 'template:instantiate')).toBe(true);
  });

  it('sender can create and instantiate but not delete', () => {
    expect(can(senderCtx, 'template:create')).toBe(true);
    expect(can(senderCtx, 'template:instantiate')).toBe(true);
    expect(can(senderCtx, 'template:delete')).toBe(false);
  });

  it('viewer can read but not modify', () => {
    expect(can(viewerCtx, 'template:read')).toBe(true);
    expect(can(viewerCtx, 'template:create')).toBe(false);
    expect(can(viewerCtx, 'template:instantiate')).toBe(false);
  });
});

describe('can() — bulk send', () => {
  it('admin and sender can create; viewer cannot', () => {
    expect(can(adminCtx, 'bulksend:create')).toBe(true);
    expect(can(senderCtx, 'bulksend:create')).toBe(true);
    expect(can(viewerCtx, 'bulksend:create')).toBe(false);
  });

  it('all roles can read; only admin/sender can cancel', () => {
    expect(can(viewerCtx, 'bulksend:read')).toBe(true);
    expect(can(viewerCtx, 'bulksend:cancel')).toBe(false);
    expect(can(senderCtx, 'bulksend:cancel')).toBe(true);
    expect(can(adminCtx, 'bulksend:cancel')).toBe(true);
  });
});

describe('can() — org admin', () => {
  it('only admin can update settings, invite, remove, read audit', () => {
    expect(can(adminCtx, 'org:update_settings')).toBe(true);
    expect(can(adminCtx, 'org:invite_member')).toBe(true);
    expect(can(adminCtx, 'org:remove_member')).toBe(true);
    expect(can(adminCtx, 'org:read_audit')).toBe(true);

    for (const ctx of [senderCtx, viewerCtx]) {
      expect(can(ctx, 'org:update_settings')).toBe(false);
      expect(can(ctx, 'org:invite_member')).toBe(false);
      expect(can(ctx, 'org:remove_member')).toBe(false);
      expect(can(ctx, 'org:read_audit')).toBe(false);
    }
  });

  it('all roles can read settings', () => {
    for (const ctx of [adminCtx, senderCtx, viewerCtx]) {
      expect(can(ctx, 'org:read_settings')).toBe(true);
    }
  });
});

describe('can() — account self-management', () => {
  it('every role can manage own account', () => {
    for (const ctx of [adminCtx, senderCtx, viewerCtx]) {
      expect(can(ctx, 'account:read_own')).toBe(true);
      expect(can(ctx, 'account:update_own')).toBe(true);
      expect(can(ctx, 'account:change_password')).toBe(true);
    }
  });
});

describe('can() — folders (org-shared structure, not writable by VIEWER)', () => {
  it('admin can create, update, delete, and assign', () => {
    expect(can(adminCtx, 'folder:create')).toBe(true);
    expect(can(adminCtx, 'folder:update')).toBe(true);
    expect(can(adminCtx, 'folder:delete')).toBe(true);
    expect(can(adminCtx, 'folder:assign_envelope')).toBe(true);
  });

  it('sender can create, update, and assign but not delete', () => {
    expect(can(senderCtx, 'folder:create')).toBe(true);
    expect(can(senderCtx, 'folder:update')).toBe(true);
    expect(can(senderCtx, 'folder:assign_envelope')).toBe(true);
    expect(can(senderCtx, 'folder:delete')).toBe(false);
  });

  it('viewer is denied folder:create', () => {
    expect(can(viewerCtx, 'folder:create')).toBe(false);
  });

  it('viewer is denied folder:update', () => {
    expect(can(viewerCtx, 'folder:update')).toBe(false);
  });

  it('viewer is denied folder:delete', () => {
    expect(can(viewerCtx, 'folder:delete')).toBe(false);
  });

  it('viewer is denied folder:assign_envelope', () => {
    expect(can(viewerCtx, 'folder:assign_envelope')).toBe(false);
  });
});

describe('can() — webhooks (admin-only)', () => {
  it('admin allowed for webhook:read and webhook:manage', () => {
    expect(can(adminCtx, 'webhook:read')).toBe(true);
    expect(can(adminCtx, 'webhook:manage')).toBe(true);
  });

  it('sender denied for webhook:read and webhook:manage', () => {
    expect(can(senderCtx, 'webhook:read')).toBe(false);
    expect(can(senderCtx, 'webhook:manage')).toBe(false);
  });

  it('viewer denied for webhook:read and webhook:manage', () => {
    expect(can(viewerCtx, 'webhook:read')).toBe(false);
    expect(can(viewerCtx, 'webhook:manage')).toBe(false);
  });
});

describe('can() — template:publish_public_form (escalation guard)', () => {
  it('SECURITY: viewer must be denied — enabling a public form mints an anonymous envelope-creating URL', () => {
    expect(can(viewerCtx, 'template:publish_public_form')).toBe(false);
  });

  it('admin and sender are allowed to publish a public form', () => {
    expect(can(adminCtx, 'template:publish_public_form')).toBe(true);
    expect(can(senderCtx, 'template:publish_public_form')).toBe(true);
  });
});

describe('can() — cross-org denial for new actions', () => {
  it('admin is denied folder:delete on a resource in another org', () => {
    expect(can(adminCtx, 'folder:delete', crossOrgEnv)).toBe(false);
  });

  it('admin is denied template:publish_public_form on a resource in another org', () => {
    expect(can(adminCtx, 'template:publish_public_form', crossOrgEnv)).toBe(false);
  });
});

describe('authorize() throws on denial', () => {
  it('throws AuthorizationError with action context', () => {
    expect(() => authorize(viewerCtx, 'envelope:create')).toThrow(AuthorizationError);
    try {
      authorize(viewerCtx, 'envelope:create');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthorizationError);
      const err = e as AuthorizationError;
      expect(err.action).toBe('envelope:create');
      expect(err.ctx.userId).toBe('u_viewer');
    }
  });

  it('does not throw when allowed', () => {
    expect(() => authorize(senderCtx, 'envelope:create')).not.toThrow();
  });
});

describe('matrix completeness', () => {
  // Every Action in the type must have an entry. If TypeScript compiles,
  // the matrix is complete by construction. This test is a runtime backstop.
  it('all known actions return a boolean for at least one role', () => {
    const actions: Action[] = [
      'envelope:create', 'envelope:read', 'envelope:update', 'envelope:send',
      'envelope:void', 'envelope:correct', 'envelope:delete', 'envelope:download_sealed', 'envelope:audit_view',
      'template:create', 'template:read', 'template:update', 'template:delete', 'template:instantiate',
      'bulksend:create', 'bulksend:read', 'bulksend:cancel',
      'org:read_settings', 'org:update_settings', 'org:invite_member', 'org:remove_member', 'org:read_audit',
      'account:read_own', 'account:update_own', 'account:change_password',
      'folder:create', 'folder:update', 'folder:delete', 'folder:assign_envelope',
      'webhook:read', 'webhook:manage',
      'template:publish_public_form',
    ];
    for (const a of actions) {
      const adminAllowed = can(adminCtx, a);
      const senderAllowed = can(senderCtx, a);
      const viewerAllowed = can(viewerCtx, a);
      expect(typeof adminAllowed).toBe('boolean');
      expect(typeof senderAllowed).toBe('boolean');
      expect(typeof viewerAllowed).toBe('boolean');
    }
  });

  it('PERMISSIONS has exactly one entry per known action, including the newly added ones', () => {
    const expectedActions: Action[] = [
      'envelope:create', 'envelope:read', 'envelope:update', 'envelope:send',
      'envelope:void', 'envelope:correct', 'envelope:delete', 'envelope:download_sealed', 'envelope:audit_view',
      'template:create', 'template:read', 'template:update', 'template:delete', 'template:instantiate',
      'bulksend:create', 'bulksend:read', 'bulksend:cancel',
      'org:read_settings', 'org:update_settings', 'org:invite_member', 'org:remove_member', 'org:read_audit',
      'account:read_own', 'account:update_own', 'account:change_password',
      'folder:create', 'folder:update', 'folder:delete', 'folder:assign_envelope',
      'webhook:read', 'webhook:manage',
      'template:publish_public_form',
    ];
    const keys = Object.keys(PERMISSIONS);
    expect(keys).toHaveLength(expectedActions.length);
    for (const a of expectedActions) {
      expect(keys).toContain(a);
    }
  });
});
