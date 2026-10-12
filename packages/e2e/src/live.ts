import { randomBytes } from 'node:crypto';
import http from 'node:http';
import {
  expect,
  test,
  type BrowserContext,
  type ConsoleMessage,
  type FrameLocator,
  type Page,
} from '@playwright/test';
import { E2E } from './env.js';

export interface VideoState {
  currentTime: number;
  paused: boolean;
  readyState: number;
  videoWidth: number;
}

/** Cookie of the live grant of one session (spec section 9.2). */
export function liveCookieName(sid: string): string {
  return `__Host-hydra_live_${sid}`;
}

/** The live iframe keeps its first src: <HYDRA_LIVE_URL>/s/<sid>/?ticket=… (spec section 9.2). */
export function liveFrameSelector(sid: string): string {
  return `iframe[src^="${E2E.liveUrl}/s/${sid}/"]`;
}

/** Opens the Live view of a session in the dashboard and returns the iframe. */
export async function openLiveView(page: Page, sid: string): Promise<FrameLocator> {
  await page.goto(`/sessions/${sid}/live`);
  await expect(page.locator(liveFrameSelector(sid))).toBeVisible({ timeout: 30_000 });
  return page.frameLocator(liveFrameSelector(sid));
}

/** State of the Neko <video>, or null while the iframe or the element is not there. */
export async function videoState(frame: FrameLocator): Promise<VideoState | null> {
  try {
    return await frame
      .locator('video')
      .first()
      .evaluate(
        (video: HTMLVideoElement) => ({
          currentTime: video.currentTime,
          paused: video.paused,
          readyState: video.readyState,
          videoWidth: video.videoWidth,
        }),
        undefined,
        { timeout: 5_000 },
      );
  } catch {
    return null;
  }
}

function plays(state: VideoState | null): boolean {
  return (
    state !== null &&
    state.readyState >= 2 &&
    !state.paused &&
    state.videoWidth > 0 &&
    state.currentTime > 0
  );
}

/** The video plays: it has frames, it is not paused, and its time moves. */
export async function expectVideoPlays(frame: FrameLocator, timeoutMs = 60_000): Promise<void> {
  await expect
    .poll(async () => plays(await videoState(frame)), {
      message: 'the live <video> plays',
      timeout: timeoutMs,
      intervals: [1_000],
    })
    .toBe(true);
  const before = (await videoState(frame))?.currentTime ?? 0;
  await expect
    .poll(async () => (await videoState(frame))?.currentTime ?? 0, {
      message: 'the live <video> time moves',
      timeout: 10_000,
    })
    .toBeGreaterThan(before);
}

/** The Neko client logs this line when its WebRTC peer fails. It does not connect again after it. */
const NEKO_PEER_FAILED = 'peer connection state changed failed';

/**
 * Opens the Live view of a session and waits until the video plays. On a CI runner, the ICE check
 * of the WebRTC peer of Neko can fail. If the peer fails, the function opens the Live view one more
 * time and adds a "flaky" annotation to the test. Other failures do not cause a second attempt.
 */
export async function openPlayingLiveView(page: Page, sid: string): Promise<FrameLocator> {
  let peerFailed = false;
  const onConsole = (message: ConsoleMessage): void => {
    if (message.text().includes(NEKO_PEER_FAILED)) {
      peerFailed = true;
    }
  };
  page.on('console', onConsole);
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      peerFailed = false;
      const frame = await openLiveView(page, sid);
      await expect
        .poll(async () => peerFailed || plays(await videoState(frame)), {
          message: 'the live <video> plays, or the Neko peer fails',
          timeout: 60_000,
          intervals: [1_000],
        })
        .toBe(true);
      if (!peerFailed) {
        await expectVideoPlays(frame);
        return frame;
      }
      test.info().annotations.push({
        type: 'flaky',
        description: `The Neko WebRTC peer of session ${sid} failed (attempt ${attempt})`,
      });
    }
  } finally {
    page.off('console', onConsole);
  }
  throw new Error(`The Neko WebRTC peer of session ${sid} failed two times`);
}

/** Value of the live grant cookie in the browser context (HttpOnly cookies are included). */
export async function liveCookieValue(context: BrowserContext, sid: string): Promise<string> {
  const cookie = (await context.cookies()).find((entry) => entry.name === liveCookieName(sid));
  if (cookie === undefined) {
    throw new Error(`No ${liveCookieName(sid)} cookie in the browser context`);
  }
  return cookie.value;
}

/**
 * Status of GET <HYDRA_LIVE_URL>/s/<sid>/ with only the grant cookie: 200 while the grant is valid,
 * 401 when it ended (spec section 9.3). 0 if the request fails. An HTTP request opens no WebSocket,
 * so it does not keep the grant alive.
 */
export async function liveStatus(
  sid: string,
  cookieValue: string,
  liveUrl: string = E2E.liveUrl,
): Promise<number> {
  try {
    const response = await fetch(`${liveUrl}/s/${sid}/`, {
      headers: { cookie: `${liveCookieName(sid)}=${cookieValue}` },
      redirect: 'manual',
    });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  }
}

/** A real mouse click on the center of the live video, as a person does it. */
export async function clickVideoCenter(page: Page, frame: FrameLocator): Promise<void> {
  const box = await frame.locator('video').first().boundingBox();
  if (box === null) {
    throw new Error('The live <video> has no bounding box');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Status of a WebSocket upgrade request that Node.js sends to the live host: 101 if the proxy
 * accepts the upgrade, else the status of the refusal (spec section 9.3). 0 if the request fails.
 * It closes the socket at once, so the grant does not stay alive because of it.
 */
export function wsUpgradeStatus(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
): Promise<number> {
  return new Promise((resolve) => {
    const request = http.request(url.replace(/^ws/, 'http'), {
      method: 'GET',
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    const finish = (status: number): void => {
      clearTimeout(timer);
      request.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => finish(0), timeoutMs);
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      finish(101);
    });
    request.on('response', (response) => {
      response.resume();
      finish(response.statusCode ?? 0);
    });
    request.on('error', () => finish(0));
    request.end();
  });
}
