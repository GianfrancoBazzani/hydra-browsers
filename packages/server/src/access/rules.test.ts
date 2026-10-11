import { ACTIONS, type Action } from '@hydra/shared';
import { describe, expect, it } from 'vitest';
import type { AuthedUser } from '../auth/types.js';
import {
  authorize,
  effectiveRole,
  nekoProfileOf,
  rightOnlyFromAdmin,
  rightsOf,
  type SessionAccessView,
} from './rules.js';

// Spec section 6.5, copied cell by cell: [action, viewer, operator, owner, admin].
const TABLE: Array<[Action, boolean, boolean, boolean, boolean]> = [
  ['session.read', true, true, true, true],
  ['live.watch', true, true, true, true],
  ['live.control', false, true, true, true],
  ['session.lifecycle', false, true, true, true],
  ['session.logs', false, true, true, true],
  ['token.create', false, true, true, true],
  ['token.revoke_own', false, true, true, true],
  ['audit.read', false, true, true, true],
  ['token.revoke_any', false, false, true, true],
  ['session.update', false, false, true, true],
  ['session.share', false, false, true, true],
  ['session.delete', false, false, true, true],
];

const OWNER_ID = 'owner-1';

function user(id: string, overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    role: 'member',
    status: 'active',
    mustChangePassword: false,
    ...overrides,
  };
}

const PRINCIPALS = {
  viewer: {
    user: user('viewer-1'),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: 'viewer' } satisfies SessionAccessView,
  },
  operator: {
    user: user('operator-1'),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: 'operator' } satisfies SessionAccessView,
  },
  owner: {
    user: user(OWNER_ID),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: null } satisfies SessionAccessView,
  },
  admin: {
    user: user('admin-1', { role: 'admin' }),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: null } satisfies SessionAccessView,
  },
};

describe('authorize: the table of spec section 6.5', () => {
  it('covers every action exactly one time', () => {
    expect(TABLE.map(([action]) => action).sort()).toEqual([...ACTIONS].sort());
  });

  const cells = TABLE.flatMap(([action, viewer, operator, owner, admin]) => [
    { action, role: 'viewer' as const, expected: viewer },
    { action, role: 'operator' as const, expected: operator },
    { action, role: 'owner' as const, expected: owner },
    { action, role: 'admin' as const, expected: admin },
  ]);

  it.each(cells)('$role / $action → $expected', ({ action, role, expected }) => {
    const { user: principal, session } = PRINCIPALS[role];
    expect(authorize(principal, session, action)).toBe(expected);
  });

  it.each(ACTIONS)('a user without a role has no right: %s', (action) => {
    const stranger = user('stranger');
    expect(authorize(stranger, PRINCIPALS.owner.session, action)).toBe(false);
  });

  it.each(['viewer', 'operator', 'owner', 'admin'] as const)(
    'a disabled %s has no right',
    (role) => {
      const { user: principal, session } = PRINCIPALS[role];
      const disabled = { ...principal, status: 'disabled' as const };
      for (const action of ACTIONS) expect(authorize(disabled, session, action)).toBe(false);
      expect(effectiveRole(disabled, session)).toBeNull();
      expect(rightsOf(disabled, session)).toEqual([]);
    },
  );
});

describe('effectiveRole, rightsOf, nekoProfileOf', () => {
  it('gives each principal its role', () => {
    expect(effectiveRole(PRINCIPALS.viewer.user, PRINCIPALS.viewer.session)).toBe('viewer');
    expect(effectiveRole(PRINCIPALS.operator.user, PRINCIPALS.operator.session)).toBe('operator');
    expect(effectiveRole(PRINCIPALS.owner.user, PRINCIPALS.owner.session)).toBe('owner');
    expect(effectiveRole(PRINCIPALS.admin.user, PRINCIPALS.admin.session)).toBe('admin');
    expect(effectiveRole(user('x'), PRINCIPALS.owner.session)).toBeNull();
  });

  it('ranks owner over admin, and admin over a member role', () => {
    const admin = user(OWNER_ID, { role: 'admin' });
    expect(effectiveRole(admin, PRINCIPALS.owner.session)).toBe('owner');
    const adminViewer = user('admin-2', { role: 'admin' });
    expect(effectiveRole(adminViewer, { id: 's1', ownerId: OWNER_ID, memberRole: 'viewer' })).toBe(
      'admin',
    );
  });

  it('lists the rights in the order of ACTIONS', () => {
    expect(rightsOf(PRINCIPALS.viewer.user, PRINCIPALS.viewer.session)).toEqual([
      'session.read',
      'live.watch',
    ]);
    expect(rightsOf(PRINCIPALS.owner.user, PRINCIPALS.owner.session)).toEqual([...ACTIONS]);
  });

  it('maps roles to Neko profiles', () => {
    expect(nekoProfileOf('owner')).toBe('admin');
    expect(nekoProfileOf('operator')).toBe('admin');
    expect(nekoProfileOf('admin')).toBe('admin');
    expect(nekoProfileOf('viewer')).toBe('user');
  });
});

describe('rightOnlyFromAdmin', () => {
  const admin = user('admin-1', { role: 'admin' });

  it('is true for an admin without a session role', () => {
    expect(rightOnlyFromAdmin(admin, PRINCIPALS.admin.session, 'session.read')).toBe(true);
  });

  it('is false when the session role gives the right', () => {
    const asOperator = { id: 's1', ownerId: OWNER_ID, memberRole: 'operator' as const };
    expect(rightOnlyFromAdmin(admin, asOperator, 'audit.read')).toBe(false);
    expect(rightOnlyFromAdmin(admin, asOperator, 'session.share')).toBe(true);
    const asOwner = { id: 's1', ownerId: admin.id, memberRole: null };
    expect(rightOnlyFromAdmin(admin, asOwner, 'session.delete')).toBe(false);
  });

  it('is false for members', () => {
    expect(
      rightOnlyFromAdmin(PRINCIPALS.operator.user, PRINCIPALS.operator.session, 'audit.read'),
    ).toBe(false);
  });
});
