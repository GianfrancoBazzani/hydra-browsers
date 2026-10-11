import type { NekoProfile } from '@hydra/shared';

/** A row of `live_grants` without the cookie HMAC (spec section 13.1). */
export interface LiveGrant {
  id: string;
  loginSessionId: string;
  userId: string;
  sessionId: string;
  nekoProfile: NekoProfile;
  createdAt: number;
  expiresAt: number;
}

/** An open WebSocket of a grant in the registry. `close()` destroys both sockets at once. */
export interface LiveSocket {
  close(reason: string): void;
}

/** Why a grant ended (spec section 9.2). Written to the log. */
export type GrantEndReason =
  | 'expired'
  | 'idle'
  | 'login_ended'
  | 'rights_changed'
  | 'session_state'
  | 'ended_by_user'
  | 'grant_deleted';
