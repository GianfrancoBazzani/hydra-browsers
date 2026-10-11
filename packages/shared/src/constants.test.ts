import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  AUDIT_KINDS,
  DEFAULT_SCREEN,
  DEFAULT_TOKEN_EXPIRY_DAYS,
  MEMBER_ROLES,
  SCREENS,
  SESSION_ROLES,
  SESSION_STATES,
  TOKEN_EXPIRY_DAYS,
} from './constants.js';
import { MESSAGES } from './messages.js';

describe('constants', () => {
  it('has no duplicate values', () => {
    for (const list of [ACTIONS, AUDIT_KINDS, SESSION_STATES, SESSION_ROLES]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('has the 12 actions of spec section 6.5 and the 22 audit kinds of spec section 13.2', () => {
    expect(ACTIONS).toHaveLength(12);
    expect(AUDIT_KINDS).toHaveLength(22);
  });

  it('member roles are the session roles without owner', () => {
    expect(MEMBER_ROLES).toEqual(SESSION_ROLES.filter((role) => role !== 'owner'));
  });

  it('defaults are members of their lists', () => {
    expect(SCREENS).toContain(DEFAULT_SCREEN);
    expect(DEFAULT_SCREEN).toBe('1920x1080');
    expect(TOKEN_EXPIRY_DAYS).toContain(DEFAULT_TOKEN_EXPIRY_DAYS);
    expect(DEFAULT_TOKEN_EXPIRY_DAYS).toBe(30);
  });

  it('keeps the exact texts of the spec', () => {
    expect(MESSAGES.invalidCredentials).toBe('Invalid email or password');
    expect(MESSAGES.sessionNotRunning).toBe('Session is not running. Start it in the dashboard.');
  });
});
