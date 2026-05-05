import { describe, it, expect } from 'vitest';
import { OrgRole } from '@prisma/client';
import { can, authorize, AuthorizationError, type AuthnContext, type Action } from './can';

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
      'envelope:void', 'envelope:delete', 'envelope:download_sealed', 'envelope:audit_view',
      'template:create', 'template:read', 'template:update', 'template:delete', 'template:instantiate',
      'bulksend:create', 'bulksend:read', 'bulksend:cancel',
      'org:read_settings', 'org:update_settings', 'org:invite_member', 'org:remove_member', 'org:read_audit',
      'account:read_own', 'account:update_own', 'account:change_password',
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
});
