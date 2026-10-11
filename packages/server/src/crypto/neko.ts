import type { NekoProfile } from '@hydra/shared';
import { hmac } from './hmac.js';

/**
 * Neko member password (spec section 6.7):
 * base64url(HMAC-SHA256(subkey neko, sid + "|" + profile)).
 */
export function nekoPassword(nekoKey: Buffer, sid: string, profile: NekoProfile): string {
  return hmac(nekoKey, `${sid}|${profile}`).toString('base64url');
}
