import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../test/helpers/config.js';
import { ConfigError, loadConfig } from './config.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const DIGEST = 'a'.repeat(64);

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    HYDRA_SECRET_KEY: KEY,
    HYDRA_PUBLIC_URL: 'https://hydra.example.com',
    HYDRA_LIVE_URL: 'https://live.hydra.example.com',
    HYDRA_PUBLIC_IP: '203.0.113.10',
    HYDRA_SESSION_IMAGE: `registry.example.com/hydra-session:abc123@sha256:${DIGEST}`,
    HYDRA_MCP_IMAGE: `registry.example.com/hydra-mcp:abc123@sha256:${DIGEST}`,
    ...overrides,
  };
}

function configError(values: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(values);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig did not throw');
}

describe('loadConfig', () => {
  it('applies the defaults of spec section 4', () => {
    const config = loadConfig(env());
    expect(config).toEqual({
      dataDir: resolve('./.data'),
      secretKey: Buffer.alloc(32, 7),
      publicUrl: new URL('https://hydra.example.com'),
      liveUrl: new URL('https://live.hydra.example.com'),
      publicIp: '203.0.113.10',
      mediaPortRange: { first: 52000, last: 52099 },
      maxRunning: 10,
      sessionNamespace: 'hydra-sessions',
      sessionTransport: 'cluster-dns',
      sessionImage: `registry.example.com/hydra-session:abc123@sha256:${DIGEST}`,
      mcpImage: `registry.example.com/hydra-mcp:abc123@sha256:${DIGEST}`,
      trustedProxies: ['10.42.0.0/16'],
      defaultTimezone: 'UTC',
      defaultLanguage: 'en-US',
      auditRetentionDays: 90,
      logLevel: 'info',
      port: 8080,
    });
  });

  it('reads all variables', () => {
    const config = loadConfig(
      env({
        HYDRA_DATA_DIR: '/var/lib/hydra-data',
        HYDRA_MEDIA_PORT_RANGE: '40000-40019',
        HYDRA_MAX_RUNNING: '20',
        HYDRA_SESSION_NAMESPACE: 'sessions-test',
        HYDRA_TRUSTED_PROXIES: '10.42.0.0/16, 192.168.0.1 ,fd00::/8',
        HYDRA_DEFAULT_TIMEZONE: 'Europe/Berlin',
        HYDRA_DEFAULT_LANGUAGE: 'de-de',
        HYDRA_AUDIT_RETENTION_DAYS: '30',
        HYDRA_LOG_LEVEL: 'debug',
        PORT: '3000',
      }),
    );
    expect(config).toMatchObject({
      dataDir: '/var/lib/hydra-data',
      mediaPortRange: { first: 40000, last: 40019 },
      maxRunning: 20,
      sessionNamespace: 'sessions-test',
      trustedProxies: ['10.42.0.0/16', '192.168.0.1', 'fd00::/8'],
      defaultTimezone: 'Europe/Berlin',
      defaultLanguage: 'de-DE',
      auditRetentionDays: 30,
      logLevel: 'debug',
      port: 3000,
    });
  });

  it.each([
    'HYDRA_SECRET_KEY',
    'HYDRA_PUBLIC_URL',
    'HYDRA_LIVE_URL',
    'HYDRA_PUBLIC_IP',
    'HYDRA_SESSION_IMAGE',
    'HYDRA_MCP_IMAGE',
  ])('names the missing necessary variable %s', (name) => {
    for (const value of [undefined, '', '   ']) {
      const error = configError(env({ [name]: value }));
      expect(error.variable).toBe(name);
      expect(error.message).toContain(`${name}: is required`);
    }
  });

  it('lists all wrong variables, one per line', () => {
    const error = configError(env({ HYDRA_PUBLIC_IP: 'nope', PORT: '0' }));
    expect(error.variable).toBe('HYDRA_PUBLIC_IP');
    expect(error.message.split('\n')).toEqual([
      'HYDRA_PUBLIC_IP: must be an IP address',
      'PORT: must be an integer from 1 to 65535',
    ]);
  });

  describe('URLs', () => {
    it('accepts http for localhost hostnames (the development URLs)', () => {
      const config = loadConfig(
        env({
          HYDRA_PUBLIC_URL: 'http://hydra.localhost:5173',
          HYDRA_LIVE_URL: 'http://live.hydra.localhost:8080',
        }),
      );
      expect(config.publicUrl.origin).toBe('http://hydra.localhost:5173');
      expect(config.liveUrl.host).toBe('live.hydra.localhost:8080');
    });

    it.each([
      ['HYDRA_PUBLIC_URL', 'http://hydra.example.com', 'must use https'],
      ['HYDRA_LIVE_URL', 'http://live.hydra.example.com', 'must use https'],
      ['HYDRA_PUBLIC_URL', 'http://hydra.localhost.example.com', 'must use https'],
      ['HYDRA_PUBLIC_URL', 'ftp://hydra.example.com', 'must use https'],
      ['HYDRA_PUBLIC_URL', 'hydra.example.com', 'must be a URL'],
      ['HYDRA_PUBLIC_URL', 'https://hydra.example.com/app', 'must be an origin'],
      ['HYDRA_PUBLIC_URL', 'https://hydra.example.com/?x=1', 'must be an origin'],
      ['HYDRA_PUBLIC_URL', 'https://user:pw@hydra.example.com', 'must be an origin'],
      ['HYDRA_PUBLIC_URL', 'https://hydra.example.com.', 'must not end with a dot'],
    ])('rejects %s=%s', (name, value, message) => {
      const error = configError(env({ [name]: value }));
      expect(error.variable).toBe(name);
      expect(error.message).toContain(message);
    });

    it('accepts a trailing slash and keeps only the origin', () => {
      const config = loadConfig(env({ HYDRA_PUBLIC_URL: 'https://Hydra.Example.com/' }));
      expect(config.publicUrl.href).toBe('https://hydra.example.com/');
    });

    it('rejects two URLs with the same hostname', () => {
      const error = configError(env({ HYDRA_LIVE_URL: 'https://hydra.example.com:8443' }));
      expect(error.variable).toBe('HYDRA_LIVE_URL');
      expect(error.message).toContain('another hostname');
    });

    it.each([
      ['https://hydra.example.com', 'https://live.hydra.example.com'],
      ['https://hydra.example.com', 'https://live.example.com'],
      ['https://hydra.example.co.uk', 'https://live.example.co.uk'],
      ['http://hydra.localhost', 'http://live.hydra.localhost'],
    ])('accepts the same site: %s and %s', (publicUrl, liveUrl) => {
      expect(() =>
        loadConfig(env({ HYDRA_PUBLIC_URL: publicUrl, HYDRA_LIVE_URL: liveUrl })),
      ).not.toThrow();
    });

    it.each([
      ['https://hydra.example.com', 'https://live.example.org'],
      ['https://a.co.uk', 'https://b.co.uk'],
      ['https://team.github.io', 'https://live.github.io'],
      ['http://localhost', 'http://live.localhost'],
      ['https://hydra.localhost', 'http://live.hydra.localhost'],
    ])('rejects different sites: %s and %s', (publicUrl, liveUrl) => {
      const error = configError(env({ HYDRA_PUBLIC_URL: publicUrl, HYDRA_LIVE_URL: liveUrl }));
      expect(error.variable).toBe('HYDRA_LIVE_URL');
      expect(error.message).toContain('same site');
    });
  });

  describe('secret key', () => {
    let folder: string | undefined;
    afterEach(() => {
      if (folder) rmSync(folder, { recursive: true, force: true });
      folder = undefined;
    });

    function keyFile(content: string): string {
      folder = mkdtempSync(join(tmpdir(), 'hydra-config-'));
      const file = join(folder, 'key');
      writeFileSync(file, content);
      return file;
    }

    it('accepts a key of more than 32 bytes', () => {
      const key = Buffer.alloc(48, 1);
      expect(loadConfig(env({ HYDRA_SECRET_KEY: key.toString('base64') })).secretKey).toEqual(key);
    });

    it('rejects a key of less than 32 bytes', () => {
      const error = configError(env({ HYDRA_SECRET_KEY: Buffer.alloc(31).toString('base64') }));
      expect(error.variable).toBe('HYDRA_SECRET_KEY');
      expect(error.message).toContain('32 bytes or more, not 31');
    });

    it.each(['not base64!', 'AAAA AAAA', 'QUJD'.repeat(10).slice(1)])('rejects %j', (value) => {
      const error = configError(env({ HYDRA_SECRET_KEY: value }));
      expect(error.variable).toBe('HYDRA_SECRET_KEY');
      expect(error.message).toContain('must be base64');
    });

    it('reads the key from HYDRA_SECRET_KEY_FILE and trims the newline', () => {
      const file = keyFile(`${Buffer.alloc(32, 9).toString('base64')}\n`);
      const config = loadConfig(env({ HYDRA_SECRET_KEY: undefined, HYDRA_SECRET_KEY_FILE: file }));
      expect(config.secretKey).toEqual(Buffer.alloc(32, 9));
    });

    it('validates the key in the file', () => {
      const file = keyFile(Buffer.alloc(16).toString('base64'));
      const error = configError(env({ HYDRA_SECRET_KEY: undefined, HYDRA_SECRET_KEY_FILE: file }));
      expect(error.variable).toBe('HYDRA_SECRET_KEY_FILE');
    });

    it('rejects a file that does not exist', () => {
      const error = configError(
        env({ HYDRA_SECRET_KEY: undefined, HYDRA_SECRET_KEY_FILE: '/nonexistent/hydra-key' }),
      );
      expect(error.variable).toBe('HYDRA_SECRET_KEY_FILE');
      expect(error.message).toContain('cannot read the file');
    });

    it('lists a missing key together with a wrong field, one per line', () => {
      const error = configError(env({ HYDRA_SECRET_KEY: undefined, HYDRA_PUBLIC_IP: 'nope' }));
      expect(error.variable).toBe('HYDRA_SECRET_KEY');
      expect(error.message.split('\n')).toEqual([
        'HYDRA_SECRET_KEY: is required (or set HYDRA_SECRET_KEY_FILE)',
        'HYDRA_PUBLIC_IP: must be an IP address',
      ]);
    });

    it('lists an unreadable key file together with a wrong field, one per line', () => {
      const error = configError(
        env({
          HYDRA_SECRET_KEY: undefined,
          HYDRA_SECRET_KEY_FILE: '/nonexistent/hydra-key',
          PORT: '0',
        }),
      );
      expect(error.variable).toBe('HYDRA_SECRET_KEY_FILE');
      const lines = error.message.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^HYDRA_SECRET_KEY_FILE: cannot read the file: /);
      expect(lines[1]).toBe('PORT: must be an integer from 1 to 65535');
    });

    it('lists both variables set together with a wrong field', () => {
      const file = keyFile(KEY);
      const error = configError(env({ HYDRA_SECRET_KEY_FILE: file, HYDRA_LOG_LEVEL: 'loud' }));
      expect(error.message.split('\n')).toEqual([
        'HYDRA_SECRET_KEY_FILE: set HYDRA_SECRET_KEY or HYDRA_SECRET_KEY_FILE, not both',
        'HYDRA_LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace',
      ]);
    });

    it('lists a short key together with a wrong field', () => {
      const error = configError(
        env({ HYDRA_SECRET_KEY: Buffer.alloc(8).toString('base64'), PORT: '0' }),
      );
      expect(error.message.split('\n')).toEqual([
        'HYDRA_SECRET_KEY: must decode to 32 bytes or more, not 8',
        'PORT: must be an integer from 1 to 65535',
      ]);
    });

    it('lists only the field if the key is good', () => {
      const error = configError(env({ HYDRA_PUBLIC_IP: 'nope' }));
      expect(error.variable).toBe('HYDRA_PUBLIC_IP');
      expect(error.message).toBe('HYDRA_PUBLIC_IP: must be an IP address');
    });

    it('never puts key material in a message', () => {
      const secret = Buffer.alloc(32, 0x5a).toString('base64');
      const wrong = `${secret.slice(0, -4)}!!!!`;
      const short = Buffer.alloc(20, 0x5a).toString('base64');
      const file = keyFile(short);
      const cases = [
        env({ HYDRA_SECRET_KEY: wrong, PORT: '0' }),
        env({ HYDRA_SECRET_KEY: short, PORT: '0' }),
        env({ HYDRA_SECRET_KEY: secret, HYDRA_SECRET_KEY_FILE: file, PORT: '0' }),
        env({ HYDRA_SECRET_KEY: undefined, HYDRA_SECRET_KEY_FILE: file, PORT: '0' }),
      ];
      for (const values of cases) {
        const { message } = configError(values);
        for (const material of [secret, wrong, short, secret.slice(0, 16), short.slice(0, 16)]) {
          expect(message).not.toContain(material);
        }
      }
    });

    it('rejects both variables at the same time', () => {
      const file = keyFile(KEY);
      const error = configError(env({ HYDRA_SECRET_KEY_FILE: file }));
      expect(error.variable).toBe('HYDRA_SECRET_KEY_FILE');
      expect(error.message).toContain('not both');
    });
  });

  describe('media ports', () => {
    it('accepts a range with exactly HYDRA_MAX_RUNNING ports', () => {
      const config = loadConfig(
        env({ HYDRA_MEDIA_PORT_RANGE: '52000-52009', HYDRA_MAX_RUNNING: '10' }),
      );
      expect(config.mediaPortRange).toEqual({ first: 52000, last: 52009 });
    });

    it('rejects a range with fewer ports than HYDRA_MAX_RUNNING', () => {
      const error = configError(
        env({ HYDRA_MEDIA_PORT_RANGE: '52000-52008', HYDRA_MAX_RUNNING: '10' }),
      );
      expect(error.variable).toBe('HYDRA_MEDIA_PORT_RANGE');
      expect(error.message).toContain('has 9 ports, fewer than HYDRA_MAX_RUNNING (10)');
    });

    it.each(['52000', '52099-52000', '0-10', '52000-70000', 'a-b', '52000 - 52099'])(
      'rejects the range %j',
      (value) => {
        expect(configError(env({ HYDRA_MEDIA_PORT_RANGE: value })).variable).toBe(
          'HYDRA_MEDIA_PORT_RANGE',
        );
      },
    );

    it('accepts a range that starts at 30128', () => {
      const config = loadConfig(env({ HYDRA_MEDIA_PORT_RANGE: '30128-30137' }));
      expect(config.mediaPortRange).toEqual({ first: 30128, last: 30137 });
    });

    it.each(['30127-30226', '30000-30099', '1-100'])(
      'rejects the range %j, whose first port is below 30128',
      (value) => {
        const error = configError(env({ HYDRA_MEDIA_PORT_RANGE: value }));
        expect(error.variable).toBe('HYDRA_MEDIA_PORT_RANGE');
        expect(error.message).toContain('first port must be 30128 or more');
      },
    );

    it.each(['0', '-1', '1.5', 'ten'])('rejects HYDRA_MAX_RUNNING=%j', (value) => {
      expect(configError(env({ HYDRA_MAX_RUNNING: value })).variable).toBe('HYDRA_MAX_RUNNING');
    });
  });

  describe('session transport', () => {
    it('accepts port-forward with localhost URLs', () => {
      const config = loadConfig(
        env({
          HYDRA_PUBLIC_URL: 'http://hydra.localhost:5173',
          HYDRA_LIVE_URL: 'http://live.hydra.localhost:8080',
          HYDRA_SESSION_TRANSPORT: 'port-forward',
        }),
      );
      expect(config.sessionTransport).toBe('port-forward');
    });

    it('rejects port-forward with other URLs', () => {
      const error = configError(env({ HYDRA_SESSION_TRANSPORT: 'port-forward' }));
      expect(error.variable).toBe('HYDRA_SESSION_TRANSPORT');
      expect(error.message).toContain('localhost');
    });

    it('rejects an unknown transport', () => {
      expect(configError(env({ HYDRA_SESSION_TRANSPORT: 'ssh' })).variable).toBe(
        'HYDRA_SESSION_TRANSPORT',
      );
    });
  });

  describe('images', () => {
    it('accepts a registry with a port', () => {
      const image = `k3d-hydra-registry.localhost:5000/hydra-session:dev@sha256:${DIGEST}`;
      expect(loadConfig(env({ HYDRA_SESSION_IMAGE: image })).sessionImage).toBe(image);
    });

    it.each([
      'registry.example.com/hydra-session:abc123',
      `registry.example.com/hydra-session@sha256:${DIGEST}`,
      `localhost:5000/hydra-session@sha256:${DIGEST}`,
      'registry.example.com/hydra-session:abc123@sha256:1234',
      `Registry.example.com/Hydra:abc@sha256:${DIGEST}`,
    ])('rejects %s', (image) => {
      expect(configError(env({ HYDRA_SESSION_IMAGE: image })).variable).toBe('HYDRA_SESSION_IMAGE');
      expect(configError(env({ HYDRA_MCP_IMAGE: image })).variable).toBe('HYDRA_MCP_IMAGE');
    });
  });

  describe('other variables', () => {
    it.each([
      ['HYDRA_PUBLIC_IP', '203.0.113'],
      ['HYDRA_TRUSTED_PROXIES', '10.42.0.0/33'],
      ['HYDRA_TRUSTED_PROXIES', 'traefik'],
      ['HYDRA_TRUSTED_PROXIES', ','],
      ['HYDRA_SESSION_NAMESPACE', 'Hydra_Sessions'],
      ['HYDRA_DEFAULT_TIMEZONE', 'Mars/Phobos'],
      ['HYDRA_DEFAULT_LANGUAGE', 'en_US'],
      ['HYDRA_AUDIT_RETENTION_DAYS', '0'],
      ['HYDRA_LOG_LEVEL', 'verbose'],
      ['PORT', '65536'],
    ])('rejects %s=%j', (name, value) => {
      expect(configError(env({ [name]: value })).variable).toBe(name);
    });

    it('accepts an IPv6 public IP', () => {
      expect(loadConfig(env({ HYDRA_PUBLIC_IP: '2001:db8::1' })).publicIp).toBe('2001:db8::1');
    });
  });
});

describe('testConfig', () => {
  it('is a valid config with localhost URLs and a fixed key', () => {
    const config = testConfig();
    expect(config.publicUrl.origin).toBe('http://hydra.localhost');
    expect(config.liveUrl.origin).toBe('http://live.hydra.localhost');
    expect(config.secretKey).toEqual(Buffer.alloc(32, 0x42));
  });

  it('applies overrides', () => {
    expect(testConfig({ maxRunning: 2 }).maxRunning).toBe(2);
  });
});
