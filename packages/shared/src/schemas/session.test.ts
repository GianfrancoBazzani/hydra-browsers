import { describe, expect, it } from 'vitest';
import { SessionActivityEventSchema, SessionStateEventSchema } from './events.js';
import {
  AllowlistSchema,
  CreateSessionRequestSchema,
  DeleteSessionRequestSchema,
  LanguageSchema,
  ListSessionsQuerySchema,
  ScreenSchema,
  SessionNameSchema,
  SessionResourceSchema,
  TimezoneSchema,
  isValidHostPattern,
} from './session.js';

function issuesOf(result: { success: boolean; error?: { issues: unknown[] } }): unknown[] {
  return result.success ? [] : (result.error?.issues ?? []);
}

describe('AllowlistSchema', () => {
  it.each([
    [['example.com']],
    [['.example.com']],
    [['a.b.example.co.uk', 'example.org']],
    [['xn--bcher-kva.de']],
    [['localhost']],
    [['my-host.example']],
    [['192.168.1.10']],
    [['.10.0.0.1']],
    [['*']],
  ])('accepts %j', (allowlist) => {
    expect(AllowlistSchema.parse(allowlist)).toEqual(allowlist);
  });

  it('trims and lowercases the entries', () => {
    expect(AllowlistSchema.parse(['  Example.COM ', '.WWW.example.org'])).toEqual([
      'example.com',
      '.www.example.org',
    ]);
  });

  it.each([
    ['https://example.com'],
    ['example.com:443'],
    ['example.com/path'],
    ['example.com?x=1'],
    ['user@example.com'],
    ['*.example.com'],
    ['exa mple.com'],
    ['-example.com'],
    ['example-.com'],
    ['example..com'],
    ['example.com.'],
    ['.'],
    [''],
    ['1.2.3'],
    ['999.1.1.1'],
    ['01.2.3.4'],
    ['bücher.de'],
    ['[::1]'],
    [`${'a'.repeat(64)}.com`],
  ])('rejects the entry %j with an issue at its index', (entry) => {
    const issues = issuesOf(AllowlistSchema.safeParse(['example.org', entry]));
    expect(issues).toEqual([expect.objectContaining({ path: [1] })]);
  });

  it('rejects an empty list', () => {
    expect(AllowlistSchema.safeParse([]).success).toBe(false);
  });

  it('accepts 100 entries and rejects 101', () => {
    const hosts = Array.from({ length: 101 }, (_, i) => `host${String(i)}.example.com`);
    expect(AllowlistSchema.safeParse(hosts.slice(0, 100)).success).toBe(true);
    expect(AllowlistSchema.safeParse(hosts).success).toBe(false);
  });

  it('rejects "*" together with other entries', () => {
    const issues = issuesOf(AllowlistSchema.safeParse(['example.com', '*']));
    expect(issues).toEqual([expect.objectContaining({ path: [1] })]);
  });

  it('rejects duplicates after normalization', () => {
    const issues = issuesOf(AllowlistSchema.safeParse(['example.com', 'EXAMPLE.com']));
    expect(issues).toEqual([expect.objectContaining({ path: [1], message: 'Duplicate host' })]);
  });

  it('accepts a host of 253 characters and rejects 254', () => {
    const label = 'a'.repeat(63);
    const host253 = `${label}.${label}.${label}.${'b'.repeat(61)}`;
    expect(host253).toHaveLength(253);
    expect(isValidHostPattern(host253)).toBe(true);
    expect(isValidHostPattern(`c${host253}`)).toBe(false);
  });
});

describe('TimezoneSchema', () => {
  it.each(['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Asia/Tokyo'])(
    'accepts %s',
    (zone) => {
      expect(TimezoneSchema.parse(zone)).toBe(zone);
    },
  );

  it('accepts current IANA names that the engine lists under an older name', () => {
    expect(TimezoneSchema.parse('Europe/Kyiv')).toBe('Europe/Kyiv');
    expect(TimezoneSchema.parse('Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it.each([
    'Europe/Kiev',
    'Asia/Calcutta',
    'Etc/GMT+1',
    'America/Port-au-Prince',
    'Africa/Dar_es_Salaam',
    'Antarctica/McMurdo',
    'Antarctica/DumontDUrville',
    'Etc/UTC',
    'US/Pacific',
  ])('accepts %s', (zone) => {
    expect(TimezoneSchema.parse(zone)).toBe(zone);
  });

  it.each([
    'Mars/Phobos',
    'utc',
    'Utc',
    'europe/berlin',
    'Europe/BERLIN',
    'europe/kyiv',
    'Europe/KYIV',
    'Europe/KyIv',
    'asia/kolkata',
    'Asia/KOLKATA',
    'America/Argentina/BUENOS_AIRES',
    'America/Port-Au-Prince',
    'Africa/Dar_Es_Salaam',
    'Antarctica/Mcmurdo',
    'Antarctica/DumontDurville',
    'Etc/Gmt+1',
    'Etc/Utc',
    'Us/Pacific',
    '+01:00',
    '',
    'Europe/',
    'Z',
  ])('rejects %j', (zone) => {
    expect(TimezoneSchema.safeParse(zone).success).toBe(false);
  });
});

describe('LanguageSchema', () => {
  it.each([
    ['en-US', 'en-US'],
    ['de', 'de'],
    ['en-us', 'en-US'],
    ['zh-hant-tw', 'zh-Hant-TW'],
    ['es-419', 'es-419'],
    ['de-CH-1996', 'de-CH-1996'],
    ['de-1901', 'de-1901'],
    ['sr-Latn-RS', 'sr-Latn-RS'],
    ['ca-ES-valencia', 'ca-ES-valencia'],
  ])('accepts %s as %s', (input, output) => {
    expect(LanguageSchema.parse(input)).toBe(output);
  });

  it.each(['en_US', 'x-private', '', 'en-US,fr', 'en--US', 'en-US-POSIX'])('rejects %j', (tag) => {
    expect(LanguageSchema.safeParse(tag).success).toBe(false);
  });

  it.each([
    'und',
    'UND',
    'und-US',
    'en-US-u-ca-gregory',
    'en-u-ca-gregory',
    'en-t-fr',
    'en-a-bbb',
    'en-x-foo',
    'en-US-x-foo',
  ])('rejects %j (undetermined language, extension or private use)', (tag) => {
    const result = LanguageSchema.safeParse(tag);
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toMatchObject([
      { message: 'Use a BCP 47 language tag such as en-US' },
    ]);
  });
});

describe('SessionNameSchema', () => {
  it('accepts 1 to 64 characters and trims', () => {
    expect(SessionNameSchema.parse('a')).toBe('a');
    expect(SessionNameSchema.parse('x'.repeat(64))).toHaveLength(64);
    expect(SessionNameSchema.parse('  Bank login  ')).toBe('Bank login');
  });

  it.each(['', '   ', 'x'.repeat(65)])('rejects %j', (name) => {
    expect(SessionNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('ScreenSchema', () => {
  it.each(['1280x720', '1600x900', '1920x1080'])('accepts %s', (screen) => {
    expect(ScreenSchema.parse(screen)).toBe(screen);
  });

  it.each(['1024x768', '1920x1080@30', ''])('rejects %j', (screen) => {
    expect(ScreenSchema.safeParse(screen).success).toBe(false);
  });
});

describe('request schemas', () => {
  it('CreateSessionRequestSchema keeps optional fields undefined', () => {
    expect(CreateSessionRequestSchema.parse({ name: 'S', allowlist: ['example.com'] })).toEqual({
      name: 'S',
      allowlist: ['example.com'],
    });
  });

  it('CreateSessionRequestSchema validates and normalizes all settings', () => {
    const result = CreateSessionRequestSchema.parse({
      name: ' S ',
      allowlist: ['Example.com'],
      timezone: 'Europe/Berlin',
      language: 'de-de',
      screen: '1280x720',
      start: false,
    });
    expect(result).toEqual({
      name: 'S',
      allowlist: ['example.com'],
      timezone: 'Europe/Berlin',
      language: 'de-DE',
      screen: '1280x720',
      start: false,
    });
  });

  it('DeleteSessionRequestSchema does not trim the confirmation', () => {
    expect(DeleteSessionRequestSchema.parse({ confirmName: ' S ' })).toEqual({
      confirmName: ' S ',
    });
  });

  it('ListSessionsQuerySchema turns all=1 into true', () => {
    expect(ListSessionsQuerySchema.parse({ all: '1' })).toEqual({ all: true });
    expect(ListSessionsQuerySchema.parse({})).toEqual({ all: false });
    expect(ListSessionsQuerySchema.safeParse({ all: 'yes' }).success).toBe(false);
  });
});

describe('response schemas', () => {
  const agentActivity = {
    activeAgentCount: 1,
    lastToolCall: { tool: 'browser_click', status: 'ok', durationMs: 230, startedAt: 1 },
  };

  it('SessionResourceSchema accepts a session that the user sees only as admin', () => {
    const resource = {
      id: 'abcdefghijkl',
      name: 'Bank login',
      owner: { id: 'u1', email: 'owner@example.com', displayName: 'Owner' },
      myRole: 'admin',
      rights: ['session.read', 'live.watch'],
      state: 'running',
      errorReason: null,
      settings: { allowlist: ['*'], timezone: 'UTC', language: 'en-US', screen: '1920x1080' },
      restartRequired: false,
      agentActivity,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(SessionResourceSchema.parse(resource)).toEqual(resource);
    expect(SessionResourceSchema.safeParse({ ...resource, myRole: 'guest' }).success).toBe(false);
  });

  it('accepts the SSE payloads', () => {
    const state = { sessionId: 'abcdefghijkl', state: 'error', errorReason: 'ErrImagePull' };
    expect(SessionStateEventSchema.parse(state)).toEqual(state);
    const activity = { sessionId: 'abcdefghijkl', agentActivity };
    expect(SessionActivityEventSchema.parse(activity)).toEqual(activity);
  });
});
