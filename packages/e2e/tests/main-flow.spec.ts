import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CreateTokenResponse, SessionResource } from '@hydra/shared';
import { deleteSessionQuietly } from '../src/api.js';
import {
  existingSessionObjects,
  nodePathExists,
  pvcVolume,
  pvExists,
  sessionObjectNames,
} from '../src/cluster.js';
import { findCookie } from '../src/cookies.js';
import { E2E, redirectUrl, setCookieUrl, testsiteUrl } from '../src/env.js';
import { expect, test } from '../src/fixtures.js';
import { expectVideoPlays, openLiveView } from '../src/live.js';
import { initializeMessage, mcpPost } from '../src/mcp-raw.js';
import { callTool, connectMcp, evaluate, mcpEndpoint, navigate } from '../src/mcp.js';

/** Spec section 8.2 step 2. */
const SESSION_NOT_RUNNING = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Session is not running. Start it in the dashboard.' },
  id: null,
};

const rootUrl = testsiteUrl('/');
const blockedRedirectUrl = redirectUrl(E2E.blockedUrl);

test('main flow: login, session, live view, agent, audit, stop and start, delete', async ({
  page,
  browser,
  adminApi,
  run,
}) => {
  test.setTimeout(15 * 60_000);
  // A new value in each run: step 9 finds exactly the cookie that step 6 set.
  const cookieValue = `e2e${run.runId}`;
  const cookieUrl = setCookieUrl(cookieValue);
  let session: SessionResource | undefined;
  let token: CreateTokenResponse | undefined;
  let mcp: Client | undefined;
  let siteCookie = '';
  let deleted = false;

  const sid = (): string => {
    if (session === undefined) throw new Error('No session yet');
    return session.id;
  };
  const secret = (): string => {
    if (token === undefined) throw new Error('No token yet');
    return token.secret;
  };
  const agent = (): Client => {
    if (mcp === undefined) throw new Error('No MCP client yet');
    return mcp;
  };

  try {
    await test.step('1. the admin from the CLI logs in on the login screen', async () => {
      // Logged-out context: the project default is the admin storage state.
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const login = await context.newPage();
      await login.goto('/login');
      // The login panel has an email field and a password field (Playwright gives both the role textbox).
      await login.locator('input[type="email"]').fill(run.admin.email);
      await login.locator('input[type="password"]').fill(`${run.admin.password}-wrong`);
      await login.locator('input[type="password"]').press('Enter');
      await expect(login.getByText('Invalid email or password')).toBeVisible();
      await login.locator('input[type="password"]').fill(run.admin.password);
      await login.locator('input[type="password"]').press('Enter');
      await expect(login.getByRole('heading', { name: 'My sessions' })).toBeVisible();
      await context.close();
    });

    await test.step('2. create a session and wait for running (less than 60 s)', async () => {
      const started = Date.now();
      const created = await adminApi.createSession({
        name: `e2e-main-${run.runId}`,
        allowlist: [E2E.testsite.host],
        timezone: 'Asia/Tokyo',
        language: 'de-DE',
        screen: '1280x720',
        start: true,
      });
      session = created;
      expect(created.settings).toEqual({
        allowlist: [E2E.testsite.host],
        timezone: 'Asia/Tokyo',
        language: 'de-DE',
        screen: '1280x720',
      });
      session = (await adminApi.waitForState(created.id, 'running', 120_000)).session;
      const elapsed = Date.now() - started;
      test.info().annotations.push({ type: 'time to running', description: `${elapsed} ms` });
      expect(elapsed, 'success criterion 2: running in less than 60 s').toBeLessThan(60_000);
      await page.goto('/');
      await expect(page.getByText(session.name, { exact: true })).toBeVisible();
    });

    await test.step('3. the live view plays the <video>', async () => {
      // Plan 07 carry-forward: the live iframe of the dashboard must not meet the foreign-Origin
      // 403 of the live proxy, neither on its HTTP requests nor on its WebSocket.
      const liveForbidden: string[] = [];
      const liveSockets: string[] = [];
      const liveSocketErrors: string[] = [];
      let liveResponses = 0;
      page.on('response', (response) => {
        if (!response.url().startsWith(E2E.liveUrl)) return;
        liveResponses += 1;
        if (response.status() === 403) {
          liveForbidden.push(`${response.request().method()} ${response.url()}`);
        }
      });
      page.on('websocket', (socket) => {
        if (!socket.url().startsWith(E2E.liveUrl.replace(/^http/, 'ws'))) return;
        liveSockets.push(socket.url());
        socket.on('socketerror', (error) => liveSocketErrors.push(`${socket.url()}: ${error}`));
      });
      await expectVideoPlays(await openLiveView(page, sid()));
      expect(liveResponses, 'responses from the live host were seen').toBeGreaterThan(0);
      expect(liveForbidden, 'no 403 from the live host').toEqual([]);
      expect(liveSockets.length, 'the Neko WebSocket opened').toBeGreaterThan(0);
      expect(liveSocketErrors, 'no WebSocket error').toEqual([]);
    });

    await test.step('4. create an agent token', async () => {
      token = await adminApi.createToken(sid(), 'e2e-agent');
      expect(token.secret).toMatch(/^hyd_[0-9A-Za-z]{40,}$/);
      expect(token.token.prefix).toBe(`${token.secret.slice(0, 12)}…`);
      await page.goto(`/sessions/${sid()}/tokens`);
      const row = page.getByRole('row').filter({ hasText: 'e2e-agent' });
      await expect(row).toContainText(token.token.prefix);
      await expect(row.getByRole('button', { name: 'Revoke' })).toBeVisible();
    });

    await test.step('5. an MCP client connects with the token', async () => {
      // The user watches the Live view while the agent works (success criterion 4).
      await expectVideoPlays(await openLiveView(page, sid()));
      mcp = await connectMcp(sid(), secret());
      const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['browser_navigate', 'browser_evaluate']));
    });

    await test.step('6. the allowlist permits the test site and blocks other domains', async () => {
      const allowed = await navigate(agent(), cookieUrl);
      expect(allowed.text).toContain(`Page URL: ${cookieUrl}`);
      const pair = findCookie(
        await evaluate(agent(), '() => document.cookie'),
        E2E.testsite.cookieName,
      );
      expect(pair, 'the test site set its cookie').toBe(
        `${E2E.testsite.cookieName}=${cookieValue}`,
      );
      siteCookie = pair ?? '';
      await expect(page.getByText('Agent active')).toBeVisible();

      const blocked = await callTool(agent(), 'browser_navigate', { url: E2E.blockedUrl });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain('ERR_BLOCKED_BY_ADMINISTRATOR');

      // Also after a redirect from an allowed site (spec section 8.7).
      const redirected = await callTool(agent(), 'browser_navigate', { url: blockedRedirectUrl });
      expect(redirected.isError).toBe(true);
      expect(redirected.text).toContain('ERR_BLOCKED_BY_ADMINISTRATOR');
    });

    await test.step('7. navigator.language and the Intl time zone follow the session settings', async () => {
      await navigate(agent(), rootUrl);
      const environment = await evaluate(
        agent(),
        '() => ({ language: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })',
      );
      expect(environment).toEqual({ language: 'de-DE', timeZone: 'Asia/Tokyo' });
    });

    await test.step('8. the audit log shows each tool call in the Activity view', async () => {
      const calls = (await adminApi.audit(sid(), { kind: 'mcp.tool_call', limit: 200 })).events.map(
        (event) => ({
          tool: event.data.tool,
          url: (event.data.arguments as { url?: unknown } | undefined)?.url,
          status: event.status,
        }),
      );
      expect(calls).toEqual(
        expect.arrayContaining([
          { tool: 'browser_navigate', url: cookieUrl, status: 'ok' },
          { tool: 'browser_navigate', url: E2E.blockedUrl, status: 'error' },
          { tool: 'browser_navigate', url: blockedRedirectUrl, status: 'error' },
          { tool: 'browser_navigate', url: rootUrl, status: 'ok' },
        ]),
      );
      expect(
        calls.filter((call) => call.tool === 'browser_evaluate' && call.status === 'ok'),
      ).toHaveLength(2);
      const connects = (await adminApi.audit(sid(), { kind: 'mcp.connect', limit: 200 })).events;
      expect(connects.map((event) => event.data.clientInfo)).toContainEqual(
        expect.objectContaining({ name: 'hydra-e2e', version: '1.0.0' }),
      );

      await page.goto(`/sessions/${sid()}/activity`);
      const rows = page.getByRole('row');
      await expect(rows.filter({ hasText: 'mcp.connect' }).first()).toBeVisible();
      // 4 or more: navigate() repeats a navigation that an error page interrupted.
      const navigateRows = rows.filter({ hasText: 'browser_navigate' });
      await expect.poll(() => navigateRows.count()).toBeGreaterThanOrEqual(4);
      const evaluateRows = rows.filter({ hasText: 'browser_evaluate' });
      await expect(evaluateRows).toHaveCount(2);
      // Live update without a reload (spec section 10.2).
      await evaluate(agent(), '() => 1');
      await expect(evaluateRows).toHaveCount(3);
    });

    await test.step('9. stop gives MCP 503; after a start the cookie of step 6 is still there', async () => {
      await agent().close();
      mcp = undefined;
      await page.goto(`/sessions/${sid()}/live`);
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await adminApi.waitForState(sid(), 'stopped', 120_000);
      const response = await mcpPost(mcpEndpoint(sid()), secret(), initializeMessage());
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual(SESSION_NOT_RUNNING);

      // The toolbar and the stopped Live view both show Start.
      await page.getByRole('button', { name: 'Start', exact: true }).first().click();
      await adminApi.waitForState(sid(), 'running', 120_000);
      mcp = await connectMcp(sid(), secret());
      await navigate(mcp, rootUrl);
      expect(
        findCookie(await evaluate(mcp, '() => document.cookie'), E2E.testsite.cookieName),
      ).toBe(siteCookie);
    });

    await test.step('10. delete removes all Kubernetes objects and the profile folder', async () => {
      await agent().close();
      mcp = undefined;
      const volume = await pvcVolume(E2E.sessionNamespace, `profile-${sid()}`);
      // Fixed folder names (spec section 5.2): <base>/hydra-sessions/profile-<sid> in the k3d node.
      expect(volume.path.endsWith(`/hydra-sessions/profile-${sid()}`)).toBe(true);
      expect(await nodePathExists(volume.node, volume.path)).toBe(true);
      expect(await existingSessionObjects(sid())).toEqual(sessionObjectNames(sid()));

      await adminApi.deleteSession(sid(), session?.name ?? '');
      deleted = true;
      await adminApi.waitForGone(sid(), 180_000);
      const poll = { timeout: 120_000, intervals: [2_000] };
      await expect.poll(() => existingSessionObjects(sid()), poll).toEqual([]);
      await expect.poll(() => pvExists(volume.pvName), poll).toBe(false);
      await expect.poll(() => nodePathExists(volume.node, volume.path), poll).toBe(false);
      // Delete revokes the tokens of the session (spec section 7.9).
      expect((await mcpPost(mcpEndpoint(sid()), secret(), initializeMessage())).status).toBe(401);
    });
  } finally {
    await mcp?.close();
    if (session !== undefined && !deleted) {
      await deleteSessionQuietly(adminApi, session);
    }
  }
});
