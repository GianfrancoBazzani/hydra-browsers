import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { closeAllSse, openSse, type SseStream } from './sse.js';

/** Reads the stream until `text` appears. */
function readUntil(stream: Readable, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    stream.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.includes(text)) resolve(received);
    });
    stream.on('error', reject);
    stream.on('end', () =>
      received.includes(text) ? resolve(received) : reject(new Error(received)),
    );
  });
}

describe('openSse', () => {
  let app: FastifyInstance;
  let opened: SseStream[];

  async function build(heartbeatMs?: number): Promise<void> {
    app = Fastify();
    opened = [];
    app.addHook('onRequest', (_request, reply, done) => {
      reply.header('x-content-type-options', 'nosniff');
      done();
    });
    app.get('/events', (_request, reply) => {
      const stream = openSse(reply, { clock: new FakeClock(), heartbeatMs });
      opened.push(stream);
      stream.send('audit', { id: 1, kind: 'auth.login' });
    });
    await app.ready();
  }

  afterEach(async () => {
    closeAllSse(app.server);
    await app.close();
  });

  it('sends the event-stream headers, hook headers, and events', async () => {
    await build();
    const response = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const text = await readUntil(response.stream(), '"auth.login"}\n\n');
    expect(text).toBe(': open\n\nevent: audit\ndata: {"id":1,"kind":"auth.login"}\n\n');
  });

  it('sends a ping comment at the heartbeat interval', async () => {
    await build(20);
    const response = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    expect(await readUntil(response.stream(), ': ping\n\n')).toContain(': ping\n\n');
  });

  it('ends the response on close() and resolves closed', async () => {
    await build();
    const response = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    const stream = response.stream();
    const ended = new Promise<void>((resolve) => stream.on('end', resolve));
    stream.resume();
    const sse = opened[0];
    if (!sse) throw new Error('no stream');
    sse.close();
    await sse.closed;
    await ended;
    sse.send('audit', { ignored: true });
    sse.close();
  });

  it('closeAllSse ends every open stream of the server', async () => {
    await build();
    await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    expect(closeAllSse(app.server)).toBe(2);
    await Promise.all(opened.map((stream) => stream.closed));
    expect(closeAllSse(app.server)).toBe(0);
  });
});
