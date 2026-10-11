import {
  request as httpRequest,
  STATUS_CODES,
  type ClientRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { NEKO_PORT, UPSTREAM_CONNECT_TIMEOUT_MS } from './constants.js';
import { liveCookieName, readCookie } from './cookies.js';
import type { LiveProxyDeps } from './deps.js';
import { forwardRequestHeaders, upgradeResponseHead } from './headers.js';
import type { UpstreamPatch } from './neko-login.js';
import { parseLivePath, upstreamPathOf } from './paths.js';
import type { LiveGrant } from './types.js';

/**
 * The WebSocket proxy of the live host (spec section 9.3). It listens to the 'upgrade' event of the
 * Node HTTP server, so every upgrade request comes here: other hosts and paths get 404. It connects
 * the browser socket and the pod socket without parsing frames and without a timeout. A browser
 * always sends Origin on a WebSocket upgrade: a present Origin that is not the live origin gets 403
 * before the grant is checked (a page of another site must not use the cookie of the user). An
 * absent Origin is allowed (non-browser clients).
 */
export function attachLiveUpgrade(server: Server, deps: LiveProxyDeps): void {
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleUpgrade(deps, request, socket, head).catch((error: unknown) => {
      // An unexpected error (spec section 12.2, `internal`): log it and answer 500 without details.
      deps.logger.error({ err: error }, 'live proxy: the upgrade failed');
      refuse(socket, 500);
    });
  });
}

async function handleUpgrade(
  deps: LiveProxyDeps,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  socket.on('error', () => socket.destroy());
  // The whole Host value, with the port of a dev URL (spec section 4): config.liveUrl.host is
  // 'live.hydra.localhost:8080' for HYDRA_LIVE_URL=http://live.hydra.localhost:8080.
  const isLiveHost = request.headers.host === deps.config.liveUrl.host;
  const target = isLiveHost ? parseLivePath(request.url ?? '') : null;
  if (target === null) {
    refuse(socket, 404);
    return;
  }
  const { origin } = request.headers;
  if (origin !== undefined && origin !== deps.config.liveUrl.origin) {
    refuse(socket, 403);
    return;
  }
  const cookie = readCookie(request.headers.cookie, liveCookieName(target.sessionId));
  const grant = deps.live.validateGrant(target.sessionId, cookie);
  if (grant === null) {
    refuse(socket, 401);
    return;
  }

  // The pod side, once it exists. A grant end destroys both sides at once.
  const pod: { request?: ClientRequest; socket?: Duplex } = {};
  const destroyAll = (): void => {
    pod.request?.destroy();
    pod.socket?.destroy();
    socket.destroy();
  };
  // The WebSocket counts as open from here, also while the connection to the pod opens.
  const release = deps.live.openSocket(grant, { close: destroyAll });
  socket.once('close', () => {
    release();
    destroyAll();
  });

  // A database error here is unexpected: attachLiveUpgrade answers 500.
  const displayName = deps.live.displayNameOf(grant.userId) ?? '';
  // A failure to find the pod or to log in to Neko means that the pod is not reachable: 502.
  const podLogin = await podTarget(deps, grant, displayName).catch((error: unknown) => {
    deps.logger.warn(
      { err: error, sessionId: grant.sessionId },
      'live proxy: the pod is not reachable',
    );
    return null;
  });
  if (podLogin === null) {
    refuse(socket, 502);
    return;
  }
  if (socket.destroyed) return;
  const { endpoint, patch } = podLogin;

  const upstreamRequest = httpRequest({
    hostname: endpoint.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: endpoint.port,
    method: 'GET',
    path: upstreamPathOf(target, patch.query),
    headers: {
      ...forwardRequestHeaders(request.headers),
      ...patch.headers,
      connection: 'Upgrade',
      upgrade: request.headers.upgrade ?? 'websocket',
    },
    agent: false,
    timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
  });
  pod.request = upstreamRequest;
  upstreamRequest.on('timeout', () => {
    upstreamRequest.destroy(new Error('connect timeout'));
  });
  upstreamRequest.on('error', (error) => {
    if (!socket.destroyed) {
      deps.logger.warn(
        { err: error, sessionId: grant.sessionId },
        'live proxy: WebSocket to the pod failed',
      );
    }
    refuse(socket, 502);
  });
  upstreamRequest.on('response', (response) => {
    deps.logger.warn(
      { sessionId: grant.sessionId, status: response.statusCode },
      'live proxy: the pod refused the WebSocket upgrade',
    );
    response.resume();
    refuse(socket, 502);
  });
  upstreamRequest.on('upgrade', (response, upstream, upstreamHead) => {
    pod.socket = upstream;
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    connect(socket, upstream, { response, head, upstreamHead, destroyAll });
  });
  upstreamRequest.end();
}

/** The pod address and the Neko login values of the upgrade. Rejects if the pod is not reachable. */
async function podTarget(
  deps: LiveProxyDeps,
  grant: LiveGrant,
  displayName: string,
): Promise<{ endpoint: URL; patch: UpstreamPatch }> {
  const endpoint = new URL(await deps.podEndpoints.endpoint(grant.sessionId, NEKO_PORT));
  const patch = await deps.live.nekoLogin.forUpgrade({
    grant,
    displayName,
    endpoint: endpoint.origin,
  });
  return { endpoint, patch };
}

/** Sends the filtered 101 head to the browser, then connects the sockets without parsing frames. */
function connect(
  browser: Duplex,
  pod: Duplex,
  input: { response: IncomingMessage; head: Buffer; upstreamHead: Buffer; destroyAll: () => void },
): void {
  for (const side of [browser, pod]) {
    if (side instanceof Socket) {
      side.setTimeout(0); // no timeout on open WebSockets (spec section 9.3)
      side.setNoDelay(true);
    }
  }
  browser.write(upgradeResponseHead(input.response));
  if (input.upstreamHead.length > 0) browser.write(input.upstreamHead);
  if (input.head.length > 0) pod.write(input.head);
  pod.on('error', input.destroyAll);
  pod.on('close', input.destroyAll);
  // pipe() also forwards the end of each direction (TCP FIN) to the other socket.
  browser.pipe(pod);
  pod.pipe(browser);
}

/** Answers an upgrade request with an HTTP error (no body, no details) and closes the socket. */
function refuse(socket: Duplex, status: 401 | 403 | 404 | 500 | 502): void {
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return;
  }
  socket.once('finish', () => socket.destroy());
  const reason = STATUS_CODES[status] ?? '';
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
