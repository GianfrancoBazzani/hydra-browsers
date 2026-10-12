import { hkdfSync } from 'node:crypto';

/** HKDF `info` labels of spec section 6.1. Changing a label invalidates the data that uses it. */
export const SUBKEY_LABELS = {
  passwordPepper: 'hydra/password-pepper/v1',
  loginSession: 'hydra/login-session/v1',
  liveGrant: 'hydra/live-grant/v1',
  agentToken: 'hydra/agent-token/v1',
  neko: 'hydra/neko/v1',
  vault: 'hydra/vault/v1',
} as const;

export interface Subkeys {
  passwordPepper: Buffer;
  loginSession: Buffer;
  liveGrant: Buffer;
  agentToken: Buffer;
  neko: Buffer;
  vault: Buffer;
}

const SUBKEY_BYTES = 32;

function derive(rootKey: Buffer, label: string): Buffer {
  // HKDF-SHA256 without a salt (RFC 5869: a zero-length salt acts as HashLen zero bytes).
  return Buffer.from(hkdfSync('sha256', rootKey, Buffer.alloc(0), label, SUBKEY_BYTES));
}

/** One 32-byte subkey for each purpose, from HYDRA_SECRET_KEY. */
export function deriveSubkeys(rootKey: Buffer): Subkeys {
  if (rootKey.length < 32) throw new RangeError('The root key must have 32 bytes or more');
  return {
    passwordPepper: derive(rootKey, SUBKEY_LABELS.passwordPepper),
    loginSession: derive(rootKey, SUBKEY_LABELS.loginSession),
    liveGrant: derive(rootKey, SUBKEY_LABELS.liveGrant),
    agentToken: derive(rootKey, SUBKEY_LABELS.agentToken),
    neko: derive(rootKey, SUBKEY_LABELS.neko),
    vault: derive(rootKey, SUBKEY_LABELS.vault),
  };
}
