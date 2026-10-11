import { randomBytes } from 'node:crypto';
import { hash, parseOptions, verify } from '@node-rs/argon2';
import { Semaphore } from '../lib/semaphore.js';

/**
 * Argon2id parameters of spec section 6.3. A change makes needsRehash() true for old hashes.
 * The algorithm and the version are the @node-rs/argon2 defaults (Argon2id, version 0x13);
 * PHC_PREFIX checks them. (The library types declare them as const enums, which
 * `verbatimModuleSyntax` cannot read.)
 */
export const ARGON2_PARAMS = {
  memoryCost: 65536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
  saltLength: 16,
} as const;

export const DEFAULT_MAX_PARALLEL = 4;
const PHC_PREFIX = '$argon2id$v=19$';

function unpaddedBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/**
 * A fixed hash with the current parameters. A verify against it costs the same as a real verify
 * and never matches (spec section 6.4: the same response time for an unknown email).
 */
const DUMMY_HASH =
  `${PHC_PREFIX}m=${String(ARGON2_PARAMS.memoryCost)},t=${String(ARGON2_PARAMS.timeCost)},` +
  `p=${String(ARGON2_PARAMS.parallelism)}` +
  `$${unpaddedBase64(Buffer.alloc(ARGON2_PARAMS.saltLength, 0x5a))}` +
  `$${unpaddedBase64(Buffer.alloc(ARGON2_PARAMS.outputLen, 0xa5))}`;

/** Argon2id password hashes (PHC strings) with the pepper as the Argon2 secret. */
export class PasswordHasher {
  readonly #pepper: Buffer;
  readonly #semaphore: Semaphore;

  constructor(pepper: Buffer, options?: { maxParallel?: number }) {
    this.#pepper = pepper;
    // Each operation uses 64 MiB of memory. Other operations wait in a queue.
    this.#semaphore = new Semaphore(options?.maxParallel ?? DEFAULT_MAX_PARALLEL);
  }

  hash(password: string): Promise<string> {
    const salt = randomBytes(ARGON2_PARAMS.saltLength);
    return this.#semaphore.run(() =>
      hash(password, {
        memoryCost: ARGON2_PARAMS.memoryCost,
        timeCost: ARGON2_PARAMS.timeCost,
        parallelism: ARGON2_PARAMS.parallelism,
        outputLen: ARGON2_PARAMS.outputLen,
        salt,
        secret: this.#pepper,
      }),
    );
  }

  /** False for a wrong password, and for a stored value that is not a valid PHC string. */
  async verify(phc: string, password: string): Promise<boolean> {
    try {
      parseOptions(phc);
    } catch {
      return this.verifyDummy(password);
    }
    return this.#semaphore.run(() => verify(phc, password, { secret: this.#pepper }));
  }

  /** A verify with the same cost against a fixed dummy hash. Always false. */
  async verifyDummy(password: string): Promise<false> {
    await this.#semaphore.run(() => verify(DUMMY_HASH, password, { secret: this.#pepper }));
    return false;
  }

  /** True if the hash does not use the current algorithm, version, and parameters. */
  needsRehash(phc: string): boolean {
    if (!phc.startsWith(PHC_PREFIX)) return true;
    try {
      const options = parseOptions(phc);
      return (
        options.memoryCost !== ARGON2_PARAMS.memoryCost ||
        options.timeCost !== ARGON2_PARAMS.timeCost ||
        options.parallelism !== ARGON2_PARAMS.parallelism ||
        options.outputLen !== ARGON2_PARAMS.outputLen ||
        options.saltLen !== ARGON2_PARAMS.saltLength
      );
    } catch {
      return true;
    }
  }
}
