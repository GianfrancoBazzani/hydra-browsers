// Spikes V1 and V2 (spec section 16) as tests: the sidecar against a real Chromium, through the gateway.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents } from '../../src/db/schema.js';
import {
  startMcpSidecar,
  startPlaywrightMcpCli,
  type PlaywrightMcp,
} from '../helpers/playwright-mcp.js';
import {
  apiRequest,
  createAgentToken,
  mcpClient,
  seedOwnerSession,
  startGateway,
  type Gateway,
} from '../helpers/mcp-gateway.js';
import { testConfig } from '../helpers/config.js';
import { pino } from 'pino';
import { loggerOptions } from '../../src/lib/logger.js';

const PASSWORD = 'Sidecar-"Pass"-é1';
const USERNAME = 'agent@app.localhost';

// Pages on *.localhost hosts: Chromium resolves them to 127.0.0.1, and each host is its own site.
function pages(port: number) {
  const p = String(port);
  const login = `<form><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><label>Code <input name="code" inputmode="numeric"></label></form>`;
  return new Map<string, string>([
    ['app.localhost/login', `<title>Login</title>${login}`],
    [
      'app.localhost/framed',
      `<title>Framed</title><iframe src="http://login.app.localhost:${p}/login" width="600" height="300"></iframe>`,
    ],
    [
      'app.localhost/evil-frame',
      `<title>Evil</title><iframe src="http://evil.localhost:${p}/login" width="600" height="300"></iframe>`,
    ],
    [
      'app.localhost/srcdoc',
      `<title>Srcdoc</title><iframe srcdoc='${login}' width="600" height="300"></iframe>`,
    ],
    ['login.app.localhost/login', `<title>Login</title>${login}`],
    ['evil.localhost/login', `<title>Login</title>${login}`],
  ]);
}

let site: Server;
let sitePort: number;
let mcp: PlaywrightMcp;

beforeAll(async () => {
  site = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0] ?? '';
    const html = pages(sitePort).get(`${host}${req.url ?? '/'}`);
    res
      .writeHead(html === undefined ? 404 : 200, { 'content-type': 'text/html' })
      .end(html ?? 'not found');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  sitePort = (site.address() as AddressInfo).port;
  mcp = await startMcpSidecar();
}, 600_000);

afterAll(async () => {
  await mcp.stop();
  await new Promise((resolve) => site.close(resolve));
});

let gw: Gateway;
let client: Client;
let credentialId: string;

const gatewayLogs: string[] = [];

beforeEach(async () => {
  gatewayLogs.length = 0;
  // Debug level: every log line of the gateway, to check that no vault value is in them (spec section 15.2).
  const logger = pino(loggerOptions('debug'), { write: (line: string) => gatewayLogs.push(line) });
  gw = await startGateway(mcp.url, {
    config: testConfig({ vaultHttpHosts: ['app.localhost'] }),
    logger,
  });
  const owner = await seedOwnerSession(gw);
  const token = await createAgentToken(gw, owner.cookie, owner.sessionId);
  const res = await apiRequest(gw, owner.cookie, 'POST', `/api/sessions/${owner.sessionId}/vault`, {
    name: 'App',
    website: 'http://app.localhost',
    username: USERNAME,
    password: PASSWORD,
    totp: { secret: 'JBSWY3DPEHPK3PXP' },
  });
  credentialId = (res.json() as { id: string }).id;
  const connection = mcpClient(gw, owner.sessionId, token.secret);
  client = connection.client;
  await client.connect(connection.transport);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  await gw.close();
});

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const text = (result: ToolResult) => result.content.map((part) => part.text ?? '').join('\n');

async function open(path: string): Promise<string> {
  await tool('browser_navigate', { url: `http://app.localhost:${String(sitePort)}${path}` });
  return text(await tool('browser_snapshot'));
}

/** The ref of the n-th element with this role and name in a snapshot, for example `textbox "Password"`. */
function refOf(snapshot: string, label: string, n = 0): string {
  const matches = [
    ...snapshot.matchAll(
      new RegExp(
        `${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\[ref=([a-z0-9]+)\\]`,
        'g',
      ),
    ),
  ];
  const ref = matches[n]?.[1];
  if (ref === undefined) throw new Error(`no ref for ${label} in:\n${snapshot}`);
  return ref;
}

describe('hydra-mcp sidecar', () => {
  it('V2: lists the tools of the playwright-mcp CLI plus the two vault tools', async () => {
    const cli = await startPlaywrightMcpCli();
    const cliGw = await startGateway(cli.url);
    try {
      const owner = await seedOwnerSession(cliGw);
      const token = await createAgentToken(cliGw, owner.cookie, owner.sessionId);
      const c = mcpClient(cliGw, owner.sessionId, token.secret);
      await c.client.connect(c.transport);
      const expected = (await c.client.listTools()).tools.map((t) => t.name);
      await c.client.close();
      const actual = (await client.listTools()).tools.map((t) => t.name);
      expect(expected).toHaveLength(25);
      expect(actual).toEqual([...expected, 'vault_list', 'vault_fill']);
    } finally {
      await cliGw.close();
      await cli.stop();
    }
  }, 120_000);

  it('V2: browser_close and the end of an MCP session do not close the Chromium tabs', async () => {
    await open('/login');
    const closed = await tool('browser_close');
    expect(closed.isError).toBe(true);
    expect(text(closed)).toContain(
      'The browser context is shared between clients and cannot be closed.',
    );
    await client.close();
    const owner = await seedOwnerSession(gw, { email: 'second@example.com' });
    const token = await createAgentToken(gw, owner.cookie, owner.sessionId);
    const second = mcpClient(gw, owner.sessionId, token.secret);
    await second.client.connect(second.transport);
    const tabs = (await second.client.callTool({
      name: 'browser_tabs',
      arguments: { action: 'list' },
    })) as ToolResult;
    expect(text(tabs)).toContain('/login');
    await second.client.close();
  }, 60_000);

  it('V1: fills the username, the password, and the code by ref, and redacts the snapshot', async () => {
    const snapshot = await open('/login');
    for (const [field, label] of [
      ['username', 'textbox "Email"'],
      ['password', 'textbox "Password"'],
      ['totp', 'textbox "Code"'],
    ] as const) {
      const result = await tool('vault_fill', {
        credentialId,
        field,
        target: refOf(snapshot, label),
        element: label,
      });
      expect(result.isError).toBeUndefined();
      expect(text(result)).toBe(`Filled the ${field} of credential ${credentialId} into ${label}.`);
    }
    const after = text(await tool('browser_snapshot'));
    expect(after).not.toContain(USERNAME);
    expect(after).not.toContain('Sidecar-');
    expect(after).toContain(`[vault:${credentialId}.password]`);
    const evaluated = text(
      await tool('browser_evaluate', {
        function: '() => document.querySelector("input[type=password]").value',
      }),
    );
    expect(evaluated).toContain(`[vault:${credentialId}.password]`);
    expect(evaluated).not.toContain('Sidecar-');
    const audit = JSON.stringify(gw.deps.db.select().from(auditEvents).all());
    expect(audit).not.toContain('Sidecar-');
    expect(audit).not.toContain(USERNAME);
    for (const logs of [gatewayLogs.join('\n'), mcp.logs()]) {
      expect(logs).not.toContain('Sidecar-');
      expect(logs).not.toContain(USERNAME);
    }
  }, 60_000);

  it('V1: fills in a same-site iframe and in a second tab that is the current tab', async () => {
    const framed = await open('/framed');
    const inFrame = await tool('vault_fill', {
      credentialId,
      field: 'password',
      target: refOf(framed, 'textbox "Password"'),
    });
    expect(inFrame.isError).toBeUndefined();
    await tool('browser_tabs', {
      action: 'new',
      url: `http://app.localhost:${String(sitePort)}/login`,
    });
    const second = text(await tool('browser_snapshot'));
    const inTab = await tool('vault_fill', {
      credentialId,
      field: 'username',
      target: refOf(second, 'textbox "Email"'),
    });
    expect(inTab.isError).toBeUndefined();
  }, 60_000);

  it('refuses a cross-site iframe, an about:srcdoc frame, and another site', async () => {
    const where = 'app.localhost and its subdomains';
    const evil = await open('/evil-frame');
    const r1 = await tool('vault_fill', {
      credentialId,
      field: 'password',
      target: refOf(evil, 'textbox "Password"'),
    });
    expect(text(r1)).toBe(
      `The element is on http://evil.localhost:${String(sitePort)}. Credential ${credentialId} fills only on ${where}.`,
    );
    const srcdoc = await open('/srcdoc');
    const r2 = await tool('vault_fill', {
      credentialId,
      field: 'password',
      target: refOf(srcdoc, 'textbox "Password"'),
    });
    expect(text(r2)).toContain('The element is on about:srcdoc.');
    await tool('browser_navigate', { url: `http://evil.localhost:${String(sitePort)}/login` });
    const other = text(await tool('browser_snapshot'));
    const r3 = await tool('vault_fill', {
      credentialId,
      field: 'password',
      target: refOf(other, 'textbox "Password"'),
    });
    expect(r3.isError).toBe(true);
    expect(text(r3)).not.toContain('Sidecar-');
  }, 60_000);
});
