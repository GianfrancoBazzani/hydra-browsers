import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HydraError } from '../lib/errors.js';
import {
  checkPasswordRules,
  generateOneTimePassword,
  isCommonPassword,
  passwordLength,
} from './passwords.js';

const EMAIL = 'alice@example.com';

function rejection(password: string, email = EMAIL): HydraError {
  try {
    checkPasswordRules(password, email);
  } catch (error) {
    if (error instanceof HydraError) return error;
    throw error;
  }
  throw new Error('expected password_rejected');
}

describe('common password list', () => {
  it('is the pinned SecLists file', () => {
    const file = readFileSync(new URL('./common-passwords.txt', import.meta.url));
    expect(createHash('sha256').update(file).digest('hex')).toBe(
      'e30e15faecc8db2d3181c3126e3b2c0cd5c187af10a5e4e83babfa157edab188',
    );
  });

  it('matches without regard to case', () => {
    expect(isCommonPassword('password1234')).toBe(true);
    expect(isCommonPassword('PASSWORD1234')).toBe(true);
    expect(isCommonPassword('correct horse battery staple')).toBe(false);
  });
});

describe('checkPasswordRules', () => {
  it('accepts a long password that is not common', () => {
    expect(() => checkPasswordRules('correct horse battery staple', EMAIL)).not.toThrow();
  });

  it('rejects fewer than 12 characters', () => {
    const error = rejection('elevenchars');
    expect(error.code).toBe('password_rejected');
    expect(error.status).toBe(400);
    expect(error.message).toBe('The password must have 12 to 128 characters.');
  });

  it('accepts exactly 12 and exactly 128 characters', () => {
    expect(() => checkPasswordRules('k3#Lm9!qZ2@x', EMAIL)).not.toThrow();
    expect(() => checkPasswordRules('a'.repeat(127) + 'b', EMAIL)).not.toThrow();
  });

  it('rejects more than 128 characters', () => {
    expect(rejection('a'.repeat(129)).message).toBe('The password must have 12 to 128 characters.');
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = '😀'.repeat(12);
    expect(emoji.length).toBe(24);
    expect(passwordLength(emoji)).toBe(12);
    expect(() => checkPasswordRules(emoji, EMAIL)).not.toThrow();
    expect(rejection('😀'.repeat(11)).code).toBe('password_rejected');
  });

  it('rejects a common password in any case', () => {
    expect(rejection('Password1234').message).toBe(
      'This password is too common. Choose another one.',
    );
    expect(rejection('QWERTY123456').code).toBe('password_rejected');
  });

  it('rejects the email as the password, in any case', () => {
    expect(rejection('Alice@Example.com').message).toBe(
      'The password must not be equal to the email.',
    );
  });

  it('has no composition rules', () => {
    expect(() => checkPasswordRules('aaaaaaaaaaaaaaaab', EMAIL)).not.toThrow();
  });
});

describe('generateOneTimePassword', () => {
  it('gives 24 base64url characters that pass the rules', () => {
    const value = generateOneTimePassword();
    expect(value).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(() => checkPasswordRules(value, EMAIL)).not.toThrow();
    expect(generateOneTimePassword()).not.toBe(value);
  });
});
