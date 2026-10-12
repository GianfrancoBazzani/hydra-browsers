// Command line of hydra-mcp (spec section 7.4). The names are the names of the playwright-mcp flags.
import { parseArgs } from 'node:util';

export interface SidecarOptions {
  cdpEndpoint: string;
  host: string;
  port: number;
  /** Host header values that the server accepts. Empty: localhost:<port> and <host>:<port>. */
  allowedHosts: string[];
  outputDir: string | undefined;
  caps: string[];
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function parseSidecarArgs(argv: readonly string[]): SidecarOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'cdp-endpoint': { type: 'string' },
      host: { type: 'string', default: 'localhost' },
      port: { type: 'string', default: '8931' },
      'allowed-hosts': { type: 'string' },
      'output-dir': { type: 'string' },
      caps: { type: 'string' },
    },
  });
  const cdpEndpoint = values['cdp-endpoint'];
  if (cdpEndpoint === undefined || cdpEndpoint === '')
    throw new Error('--cdp-endpoint is required');
  const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535)
    throw new Error('--port must be an integer from 0 to 65535');
  return {
    cdpEndpoint,
    host: values.host,
    port,
    allowedHosts: list(values['allowed-hosts']),
    outputDir: values['output-dir'],
    caps: list(values.caps),
  };
}
