import {
  ACTIONS,
  type Action,
  type MemberRole,
  type NekoProfile,
  type SessionRole,
} from '@hydra/shared';
import type { AuthedUser } from '../auth/types.js';

export interface SessionAccessView {
  id: string;
  ownerId: string;
  memberRole: MemberRole | null;
}

export type EffectiveRole = SessionRole | 'admin';

const VIEWER_RIGHTS: readonly Action[] = ['session.read', 'live.watch', 'vault.read'];
const OPERATOR_RIGHTS: readonly Action[] = [
  ...VIEWER_RIGHTS,
  'live.control',
  'session.lifecycle',
  'session.logs',
  'token.create',
  'token.revoke_own',
  'audit.read',
];

/** The table of spec section 6.5. `authorize()` is the only place that reads it. */
const ROLE_RIGHTS: Record<EffectiveRole, ReadonlySet<Action>> = {
  viewer: new Set(VIEWER_RIGHTS),
  operator: new Set(OPERATOR_RIGHTS),
  owner: new Set(ACTIONS),
  admin: new Set(ACTIONS),
};

/**
 * The role whose rights apply: owner, then the global admin role, then the member role.
 * Disabled users have no role. An admin who is also a member gets 'admin', because the admin
 * rights are a superset; thus `nekoProfileOf(effectiveRole(...))` is right for this user too.
 */
export function effectiveRole(user: AuthedUser, session: SessionAccessView): EffectiveRole | null {
  if (user.status !== 'active') return null;
  if (session.ownerId === user.id) return 'owner';
  if (user.role === 'admin') return 'admin';
  return session.memberRole;
}

export function authorize(user: AuthedUser, session: SessionAccessView, action: Action): boolean {
  const role = effectiveRole(user, session);
  return role !== null && ROLE_RIGHTS[role].has(action);
}

/** All actions that the user can do on the session, in the order of ACTIONS. */
export function rightsOf(user: AuthedUser, session: SessionAccessView): Action[] {
  return ACTIONS.filter((action) => authorize(user, session, action));
}

/** Spec section 6.7: owner, operator, and admin get the Neko admin profile; viewer gets user. */
export function nekoProfileOf(role: EffectiveRole): NekoProfile {
  return role === 'viewer' ? 'user' : 'admin';
}

/** True if the user has the right only because of the global admin role (index 5.8 rule). */
export function rightOnlyFromAdmin(
  user: AuthedUser,
  session: SessionAccessView,
  action: Action,
): boolean {
  if (user.status !== 'active' || user.role !== 'admin') return false;
  const sessionRole: SessionRole | null =
    session.ownerId === user.id ? 'owner' : session.memberRole;
  return sessionRole === null || !ROLE_RIGHTS[sessionRole].has(action);
}
