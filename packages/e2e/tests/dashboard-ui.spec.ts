import type { Page } from '@playwright/test';
import { E2E } from '../src/env.js';
import { expect, test } from '../src/fixtures.js';
import {
  expectVideoPlays,
  liveCookieName,
  liveCookieValue,
  openLiveView,
  wsUpgradeStatus,
} from '../src/live.js';

/**
 * Dashboard behaviours that jsdom cannot show (plan 07 carry-forwards): the Radix pointer-events
 * lock, a real EventSource reconnect, and the live iframe of a viewer.
 */

const bodyPointerEvents = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).pointerEvents);

test('a Radix sheet that opens from a row menu does not leave the page unclickable', async ({
  page,
  run,
}) => {
  await page.goto('/admin/users');
  const trigger = (email: string) => page.getByRole('button', { name: `Actions for ${email}` });
  await expect(trigger(run.viewer.email)).toBeVisible();

  const closers = [
    {
      name: 'Cancel',
      close: async () => {
        await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 5_000 });
      },
    },
    {
      name: 'Escape',
      close: async () => {
        await page.keyboard.press('Escape');
      },
    },
    // The same sequence twice with each way to close (the Radix issue shows on a later run too).
    {
      name: 'Cancel (again)',
      close: async () => {
        await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 5_000 });
      },
    },
    {
      name: 'Escape (again)',
      close: async () => {
        await page.keyboard.press('Escape');
      },
    },
  ];

  for (const { name, close } of closers) {
    await test.step(`row menu, Change name sheet, close with ${name}`, async () => {
      // The viewer row: "Change name" opens a sheet that changes nothing until Save.
      await trigger(run.viewer.email).click({ timeout: 5_000 });
      await page.getByRole('menuitem', { name: 'Change name' }).click({ timeout: 5_000 });
      const sheet = page.getByRole('dialog', { name: 'Change name' });
      await expect(sheet).toBeVisible();
      // While the sheet is open, the modal Radix Dialog locks the page with pointer-events: none
      // on the body. This is the positive control of the probe: without it, the check "not none
      // after closing" would pass even if the probe could never see the lock.
      await expect
        .poll(() => bodyPointerEvents(page), {
          message: `body pointer-events with the sheet open (${name}): the probe must see the lock`,
          timeout: 3_000,
        })
        .toBe('none');

      await close();
      await expect(sheet).toHaveCount(0);

      // The lock is gone: not 'none' on the body, and no inline value stays.
      await expect
        .poll(() => bodyPointerEvents(page), {
          message: `body pointer-events after ${name} (a stuck "none" is a plan 07 finding)`,
          timeout: 3_000,
        })
        .not.toBe('none');
      expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe('none');
      // The focus returns to the button that opened the menu (Sheet returnFocusRef).
      await expect(trigger(run.viewer.email)).toBeFocused();

      // A real click on another row menu (Playwright waits for a hit target, so a locked page
      // makes it time out), then on the sidebar.
      await trigger(run.outsider.email).click({ timeout: 5_000 });
      await expect(page.getByRole('menuitem', { name: 'Change name' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect
        .poll(() => bodyPointerEvents(page), { message: 'body pointer-events after the menu' })
        .not.toBe('none');

      await page.getByRole('link', { name: 'All sessions' }).click({ timeout: 5_000 });
      await expect(page).toHaveURL(/\/admin\/sessions$/);
      await page.getByRole('link', { name: 'Users' }).click({ timeout: 5_000 });
      await expect(page).toHaveURL(/\/admin\/users$/);
      await expect(trigger(run.viewer.email)).toBeVisible();
    });
  }

  // The Create user sheet (a Dialog without a menu in front of it) opens and closes too.
  await page.getByRole('button', { name: 'Create user' }).click({ timeout: 5_000 });
  await expect(page.getByRole('dialog', { name: 'Create user' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 5_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => bodyPointerEvents(page), { message: 'body pointer-events after Create user' })
    .not.toBe('none');
  await page.getByRole('link', { name: 'All sessions' }).click({ timeout: 5_000 });
  await expect(page).toHaveURL(/\/admin\/sessions$/);
});

test('a rights change ends the event stream and the dashboard reconnects without a reload', async ({
  adminApi,
  pageAs,
  run,
  sessionPair,
}) => {
  test.setTimeout(3 * 60_000);
  // The session b of the pair is not shared with the viewer by any other test.
  const { b } = sessionPair;
  const viewerPage = await pageAs('viewer');
  const eventRequests: string[] = [];
  viewerPage.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/events') eventRequests.push(request.url());
  });
  let navigations = 0;
  viewerPage.on('framenavigated', (frame) => {
    if (frame === viewerPage.mainFrame()) navigations += 1;
  });

  await viewerPage.goto('/');
  await expect(viewerPage.getByText('Nothing is shared with you')).toBeVisible();
  await expect(viewerPage.getByText(b.name, { exact: true })).toHaveCount(0);
  await expect.poll(() => eventRequests.length, { message: 'the first /api/events' }).toBe(1);
  const navigationsAtStart = navigations;
  // A marker that a reload (a new document) would remove.
  await viewerPage.evaluate(() => {
    (window as unknown as { e2eMarker: string }).e2eMarker = 'same document';
  });

  let shared = false;
  try {
    // Share: rights.changed closes the stream of the viewer, the page connects again and
    // fetches the sessions again (spec sections 6.5 and 10.3).
    const reconnectAfterShare = viewerPage.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/events',
      { timeout: 30_000 },
    );
    const refetchAfterShare = viewerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/sessions' &&
        response.request().method() === 'GET',
      { timeout: 30_000 },
    );
    await adminApi.addMember(b.id, run.viewer.email, 'viewer');
    shared = true;
    await reconnectAfterShare;
    await refetchAfterShare;
    await expect(viewerPage.getByText(b.name, { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(eventRequests.length, 'a new /api/events request, not one long stream').toBe(2);

    // Unshare: the same, in the other direction.
    const reconnectAfterRemove = viewerPage.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/events',
      { timeout: 30_000 },
    );
    await adminApi.removeMember(b.id, run.viewer.id);
    shared = false;
    await reconnectAfterRemove;
    await expect(viewerPage.getByText(b.name, { exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(viewerPage.getByText('Nothing is shared with you')).toBeVisible();
    expect(eventRequests.length, 'a third /api/events request').toBe(3);

    expect(navigations, 'no page navigation').toBe(navigationsAtStart);
    expect(
      await viewerPage.evaluate(() => (window as unknown as { e2eMarker?: string }).e2eMarker),
    ).toBe('same document');
  } finally {
    if (shared) await adminApi.removeMember(b.id, run.viewer.id);
  }
});

test('a viewer sees the live view without a 403 from the live host, and a foreign Origin gets 403', async ({
  adminApi,
  pageAs,
  run,
  sessionPair,
}) => {
  test.setTimeout(5 * 60_000);
  const { a } = sessionPair;
  const member = await adminApi.addMember(a.id, run.viewer.email, 'viewer');
  try {
    const viewerPage = await pageAs('viewer');
    const liveForbidden: string[] = [];
    const liveSockets: string[] = [];
    const liveSocketErrors: string[] = [];
    let liveResponses = 0;
    viewerPage.on('response', (response) => {
      if (!response.url().startsWith(E2E.liveUrl)) return;
      liveResponses += 1;
      if (response.status() === 403) {
        liveForbidden.push(`${response.request().method()} ${response.url()}`);
      }
    });
    viewerPage.on('websocket', (socket) => {
      if (!socket.url().startsWith(E2E.liveUrl.replace(/^http/, 'ws'))) return;
      liveSockets.push(socket.url());
      socket.on('socketerror', (error) => liveSocketErrors.push(`${socket.url()}: ${error}`));
    });

    await expectVideoPlays(await openLiveView(viewerPage, a.id));
    expect(liveResponses, 'responses from the live host were seen').toBeGreaterThan(0);
    expect(liveForbidden, 'no 403 from the live host for the viewer').toEqual([]);
    expect(liveSockets.length, 'the Neko WebSocket of the viewer opened').toBeGreaterThan(0);
    expect(liveSocketErrors, 'no WebSocket error').toEqual([]);

    // Negative control with Node.js. The grant cookie of the viewer is valid (the live view is
    // open), so only the Origin decides. The WebSocket proxy answers 403 to a present Origin that
    // is not the live origin, before it checks the grant (packages/server/src/live-proxy/ws-proxy.ts).
    // Spec section 9.3 says only "the upgrade is refused" and names no status: the 403 comes from
    // the product, not from the spec text.
    const cookie = `${liveCookieName(a.id)}=${await liveCookieValue(viewerPage.context(), a.id)}`;
    const socketUrl = liveSockets[0] ?? '';
    const liveOrigin = new URL(E2E.liveUrl).origin;
    expect(
      await wsUpgradeStatus(socketUrl, { cookie, origin: liveOrigin }),
      'control: the live origin with the grant cookie is accepted',
    ).toBe(101);
    expect(
      await wsUpgradeStatus(socketUrl, { cookie, origin: 'http://evil.example' }),
      'a foreign Origin with a valid grant cookie',
    ).toBe(403);
    expect(
      await wsUpgradeStatus(socketUrl, { cookie, origin: new URL(E2E.publicUrl).origin }),
      'the dashboard origin is not the live origin',
    ).toBe(403);
    expect(
      await wsUpgradeStatus(socketUrl, { origin: 'http://evil.example' }),
      'a foreign Origin without a cookie: the Origin check comes first',
    ).toBe(403);
    expect(
      await wsUpgradeStatus(socketUrl, { origin: liveOrigin }),
      'the live origin without a grant cookie',
    ).toBe(401);
  } finally {
    await adminApi.removeMember(a.id, member.userId);
  }
});
