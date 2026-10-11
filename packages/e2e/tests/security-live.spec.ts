import { setTimeout as sleep } from 'node:timers/promises';
import { testsiteUrl } from '../src/env.js';
import { expect, test } from '../src/fixtures.js';
import {
  clickVideoCenter,
  expectVideoPlays,
  liveCookieValue,
  liveStatus,
  openLiveView,
  videoState,
} from '../src/live.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool, connectMcp, evaluate, navigate } from '../src/mcp.js';

/** A button over the whole page. A click on it sets the title to "clicked". */
const CLICK_TARGET = `() => {
  document.title = 'waiting';
  const button = document.createElement('button');
  button.textContent = 'hydra e2e click target';
  button.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;font-size:48px';
  button.addEventListener('click', () => { document.title = 'clicked'; });
  document.body.append(button);
  return document.title;
}`;

/**
 * The SponsorBlock extension opens its welcome page in a new foreground tab about 10 s after the
 * first start of Chromium. Clicks on the live video would land on that tab, not on the test page,
 * and the check of the viewer would pass without any proof. So the test waits for the tab, closes
 * it, and selects the tab of the test site.
 */
async function focusTestPage(mcp: Client): Promise<void> {
  const tabs = async (): Promise<string[]> =>
    (await callTool(mcp, 'browser_tabs', { action: 'list' })).text
      .split('\n')
      .filter((line) => /^- \d+:/.test(line));
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const extension = (await tabs()).find((line) => line.includes('chrome-extension://'));
    if (extension !== undefined) {
      await callTool(mcp, 'browser_tabs', {
        action: 'close',
        index: Number.parseInt(extension.slice(2), 10),
      });
      break;
    }
    await sleep(1_000);
  }
  const page = (await tabs()).find((line) => line.includes(testsiteUrl('/')));
  if (page === undefined) {
    throw new Error('The test page tab is gone');
  }
  await callTool(mcp, 'browser_tabs', {
    action: 'select',
    index: Number.parseInt(page.slice(2), 10),
  });
}

test('a viewer cannot take control in Neko', async ({
  page,
  pageAs,
  adminApi,
  run,
  sessionPair,
}) => {
  test.setTimeout(8 * 60_000);
  const { a } = sessionPair;
  const member = await adminApi.addMember(a.id, run.viewer.email, 'viewer');
  const token = await adminApi.createToken(a.id, 'e2e-viewer-check');
  const mcp = await connectMcp(a.id, token.secret);
  const title = async (): Promise<unknown> => {
    try {
      return await evaluate(mcp, '() => document.title');
    } catch {
      return 'evaluate failed';
    }
  };
  try {
    await navigate(mcp, testsiteUrl('/'));
    await focusTestPage(mcp);
    expect(await evaluate(mcp, CLICK_TARGET)).toBe('waiting');

    const viewerPage = await pageAs('viewer');
    const viewerFrame = await openLiveView(viewerPage, a.id);
    await expectVideoPlays(viewerFrame);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await clickVideoCenter(viewerPage, viewerFrame);
      await sleep(1_000);
    }
    expect(await title(), 'the clicks of the viewer did not reach Chromium').toBe('waiting');

    // Control: the same click by the owner reaches Chromium (implicit hosting, spec section 9.4).
    const ownerFrame = await openLiveView(page, a.id);
    await expectVideoPlays(ownerFrame);
    await expect
      .poll(
        async () => {
          await clickVideoCenter(page, ownerFrame);
          return title();
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe('clicked');
  } finally {
    await mcp.close();
    await adminApi.revokeToken(a.id, token.token.id);
    await adminApi.removeMember(a.id, member.userId);
  }
});

test('two browser tabs show two sessions at the same time, and both live views stay connected', async ({
  page,
  sessionPair,
}) => {
  const { a, b } = sessionPair;
  const second = await page.context().newPage();
  const frameA = await openLiveView(page, a.id);
  const frameB = await openLiveView(second, b.id);
  await expectVideoPlays(frameA);
  await expectVideoPlays(frameB);
  // One grant cookie for each session (spec section 9.2).
  expect(await liveCookieValue(page.context(), a.id)).not.toBe('');
  expect(await liveCookieValue(page.context(), b.id)).not.toBe('');

  const startA = (await videoState(frameA))?.currentTime ?? 0;
  const startB = (await videoState(frameB))?.currentTime ?? 0;
  await sleep(40_000);
  const endA = await videoState(frameA);
  const endB = await videoState(frameB);
  // A reconnect starts a new stream at time 0, so 30 s more of video time means one open connection.
  expect(endA?.paused).toBe(false);
  expect(endB?.paused).toBe(false);
  expect((endA?.currentTime ?? 0) - startA).toBeGreaterThan(30);
  expect((endB?.currentTime ?? 0) - startB).toBeGreaterThan(30);
});

test('opening another session in the same browser tab ends the previous live grant at once', async ({
  page,
  sessionPair,
}) => {
  const { a, b } = sessionPair;
  await expectVideoPlays(await openLiveView(page, a.id));
  const cookieA = await liveCookieValue(page.context(), a.id);
  expect(await liveStatus(a.id, cookieA)).toBe(200);

  const endGrant = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `/api/sessions/${a.id}/live-grant`,
  );
  await page.getByText(b.name, { exact: true }).click();
  expect((await endGrant).ok()).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/sessions/${b.id}/`));
  await expect
    .poll(() => liveStatus(a.id, cookieA), { timeout: 2_000, intervals: [250] })
    .toBe(401);
});

test('30 s after a live view closes, its grant cookie gets 401', async ({ page, sessionPair }) => {
  const { a } = sessionPair;
  const view = await page.context().newPage();
  await expectVideoPlays(await openLiveView(view, a.id));
  const cookie = await liveCookieValue(page.context(), a.id);
  await view.close();
  const closedAt = Date.now();

  expect(await liveStatus(a.id, cookie), 'the grant is valid right after the view closed').toBe(
    200,
  );
  await sleep(Math.max(0, closedAt + 20_000 - Date.now()));
  expect(await liveStatus(a.id, cookie), 'the grant is valid 20 s after the view closed').toBe(200);
  await expect
    .poll(() => liveStatus(a.id, cookie), { timeout: 30_000, intervals: [1_000] })
    .toBe(401);
  const elapsed = Date.now() - closedAt;
  test.info().annotations.push({ type: 'grant ended after', description: `${elapsed} ms` });
  expect(elapsed).toBeGreaterThanOrEqual(29_000);
  expect(elapsed).toBeLessThanOrEqual(50_000);
});
