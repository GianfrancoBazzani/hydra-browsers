import { readFileSync } from 'node:fs';
import { randomBase64Url } from '../crypto/index.js';
import { HydraError } from '../lib/errors.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// SecLists 10-million-password-list-top-100000.txt at commit f0ab724 (see the plan, Task 1).
const COMMON_PASSWORDS_FILE = new URL('./common-passwords.txt', import.meta.url);

let commonPasswords: Set<string> | undefined;

/** Length in Unicode code points, as NIST SP 800-63B counts characters. */
export function passwordLength(password: string): number {
  return [...password].length;
}

function loadCommonPasswords(): Set<string> {
  const entries = new Set<string>();
  for (const line of readFileSync(COMMON_PASSWORDS_FILE, 'utf8').split('\n')) {
    const entry = line.replace(/\r$/, '').toLowerCase();
    const length = passwordLength(entry);
    // Shorter or longer entries can never pass the length rule, so the set does not keep them.
    if (length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH) entries.add(entry);
  }
  return entries;
}

export function isCommonPassword(password: string): boolean {
  commonPasswords ??= loadCommonPasswords();
  return commonPasswords.has(password.toLowerCase());
}

/** Spec section 6.3. Throws HydraError password_rejected. */
export function checkPasswordRules(password: string, email: string): void {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new HydraError(
      'password_rejected',
      `The password must have ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
    );
  }
  if (password.toLowerCase() === email.trim().toLowerCase()) {
    throw new HydraError('password_rejected', 'The password must not be equal to the email.');
  }
  if (isCommonPassword(password)) {
    throw new HydraError('password_rejected', 'This password is too common. Choose another one.');
  }
}

/** One-time password for a new user or a reset: 18 random bytes, 24 base64url characters. */
export function generateOneTimePassword(): string {
  return randomBase64Url(18);
}
