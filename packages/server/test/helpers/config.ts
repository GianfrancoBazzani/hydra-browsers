import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../../src/config/config.js';

const DIGEST = '0'.repeat(64);

/**
 * A valid Config for tests: public http://hydra.localhost, live http://live.hydra.localhost, and a
 * fixed 32-byte key. `dataDir` is a path that does not exist; tests that write files pass their
 * own folder (for example createTestDb().dataDir).
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const config = loadConfig({
    HYDRA_DATA_DIR: join(tmpdir(), 'hydra-test-config-unused'),
    HYDRA_SECRET_KEY: Buffer.alloc(32, 0x42).toString('base64'),
    HYDRA_PUBLIC_URL: 'http://hydra.localhost',
    HYDRA_LIVE_URL: 'http://live.hydra.localhost',
    HYDRA_PUBLIC_IP: '127.0.0.1',
    HYDRA_SESSION_IMAGE: `registry.test/hydra-session:test@sha256:${DIGEST}`,
    HYDRA_MCP_IMAGE: `registry.test/hydra-mcp:test@sha256:${DIGEST}`,
  });
  return { ...config, ...overrides };
}
