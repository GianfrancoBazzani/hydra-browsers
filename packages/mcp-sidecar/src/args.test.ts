import { describe, expect, it } from 'vitest';
import { parseSidecarArgs } from './args.js';

describe('parseSidecarArgs', () => {
  it('reads the flags of spec section 7.4', () => {
    expect(
      parseSidecarArgs([
        '--cdp-endpoint',
        'http://127.0.0.1:9222',
        '--host',
        '0.0.0.0',
        '--port',
        '8931',
      ]),
    ).toEqual({
      cdpEndpoint: 'http://127.0.0.1:9222',
      host: '0.0.0.0',
      port: 8931,
      allowedHosts: [],
      outputDir: undefined,
      caps: [],
    });
  });

  it('reads the test flags, and needs --cdp-endpoint', () => {
    expect(
      parseSidecarArgs([
        '--cdp-endpoint',
        'x',
        '--port',
        '0',
        '--allowed-hosts',
        'localhost:8931',
        '--output-dir',
        '/tmp/o',
        '--caps',
        'vision,pdf',
      ]),
    ).toMatchObject({
      port: 0,
      allowedHosts: ['localhost:8931'],
      outputDir: '/tmp/o',
      caps: ['vision', 'pdf'],
    });
    expect(() => parseSidecarArgs([])).toThrow('--cdp-endpoint');
    expect(() => parseSidecarArgs(['--cdp-endpoint', 'x', '--port', 'abc'])).toThrow('--port');
  });
});
