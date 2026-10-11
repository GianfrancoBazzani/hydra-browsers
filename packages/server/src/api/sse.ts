import type { OutgoingHttpHeaders, Server } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { Clock } from '../lib/clock.js';

/** Spec section 10.3: a comment line every 25 s, so proxies do not close an idle stream. */
export const SSE_HEARTBEAT_MS = 25_000;

export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  /** Resolves when the stream ends, by `close()` or because the client went away. */
  closed: Promise<void>;
}

// Open streams for each HTTP server, so `app.close()` can end them (preClose hook in app.ts).
const openStreams = new WeakMap<Server, Set<SseStream>>();

/**
 * Takes over the reply and starts a `text/event-stream` response. The headers that hooks set
 * before (the security headers of spec section 6.8) are kept. `clock` is part of the shared
 * signature (index section 5.9); the heartbeat uses a timer.
 */
export function openSse(
  reply: FastifyReply,
  options: { clock: Clock; heartbeatMs?: number },
): SseStream {
  reply.hijack();
  const res = reply.raw;
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) res.setHeader(name, value);
  }
  const headers: OutgoingHttpHeaders = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  };
  res.writeHead(200, headers);
  res.write(': open\n\n');

  const server = reply.server.server;
  let done = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const heartbeat = setInterval(() => {
    if (!done) res.write(': ping\n\n');
  }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const stream: SseStream = {
    send(event, data) {
      if (!done) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (done) return;
      finish();
      res.end();
    },
    closed,
  };

  function finish(): void {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    openStreams.get(server)?.delete(stream);
    resolveClosed();
  }

  res.on('close', finish);
  let set = openStreams.get(server);
  if (!set) {
    set = new Set();
    openStreams.set(server, set);
  }
  set.add(stream);
  return stream;
}

/** Ends all open SSE streams of a server. Returns how many were open. */
export function closeAllSse(server: Server): number {
  const set = openStreams.get(server);
  if (!set) return 0;
  const streams = [...set];
  for (const stream of streams) stream.close();
  return streams.length;
}
