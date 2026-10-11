import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger, loggerOptions } from './logger.js';

function captureLogger(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { logger: pino(loggerOptions('info'), stream), lines };
}

describe('logger', () => {
  it('redacts the credential headers of spec section 14', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      req: { headers: { authorization: 'Bearer hyd_x', cookie: 'a=b', host: 'hydra.example.com' } },
      res: { headers: { 'set-cookie': ['c=d'], 'content-type': 'text/html' } },
    });
    expect(lines[0]).toMatchObject({
      req: {
        headers: { authorization: '[redacted]', cookie: '[redacted]', host: 'hydra.example.com' },
      },
      res: { headers: { 'set-cookie': '[redacted]', 'content-type': 'text/html' } },
    });
  });

  it('redacts fields named password, token, and ticket up to three levels deep', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      password: 'p0',
      token: 't0',
      ticket: 'k0',
      body: { password: 'p1', nested: { token: 't2', deeper: { ticket: 'k3' } } },
      list: [{ password: 'p-in-array' }],
      visible: 'ok',
    });
    expect(lines[0]).toMatchObject({
      password: '[redacted]',
      token: '[redacted]',
      ticket: '[redacted]',
      body: {
        password: '[redacted]',
        nested: { token: '[redacted]', deeper: { ticket: '[redacted]' } },
      },
      list: [{ password: '[redacted]' }],
      visible: 'ok',
    });
  });

  it('createLogger uses the configured level', () => {
    expect(createLogger('warn').level).toBe('warn');
  });
});
