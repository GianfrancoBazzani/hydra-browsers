// Encryption of vault values (spec section 6.9.3): AES-256-GCM with the subkey vault.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { VaultField } from '@hydra/shared';

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The additional authenticated data: a ciphertext cannot move to another session, credential, or field. */
export interface ValueAad {
  sessionId: string;
  credentialId: string;
  field: VaultField;
}

function aadOf(aad: ValueAad): Buffer {
  return Buffer.from(`${aad.sessionId}|${aad.credentialId}|${aad.field}`, 'utf8');
}

/** Version byte 0x01, 12-byte random nonce, ciphertext, 16-byte tag. */
export function encryptValue(key: Buffer, aad: ValueAad, plaintext: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(aad));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
}

/**
 * A value that cannot be decrypted: another key, changed data, or another AAD. The message names the
 * credential (spec section 6.9.3: the gateway logs the credential ID, never a value).
 */
export class VaultDecryptError extends Error {
  readonly credentialId: string;

  constructor(credentialId: string) {
    super(`A vault value of credential ${credentialId} cannot be decrypted.`);
    this.name = 'VaultDecryptError';
    this.credentialId = credentialId;
  }
}

export function decryptValue(key: Buffer, aad: ValueAad, blob: Buffer): string {
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== VERSION)
    throw new VaultDecryptError(aad.credentialId);
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const body = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadOf(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultDecryptError(aad.credentialId);
  }
}
