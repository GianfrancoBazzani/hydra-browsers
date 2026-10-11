import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/index.js';

function dbAnswers(db: Db): boolean {
  try {
    return db.get<{ ok: number }>(sql`select 1 as ok`)?.ok === 1;
  } catch {
    return false;
  }
}

/** Spec section 14. No host constraint: kubelet probes use the pod IP. */
export function registerHealthRoutes(
  app: FastifyInstance,
  deps: Pick<AppDeps, 'db' | 'kube'>,
): void {
  app.get('/healthz', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const checks = { db: dbAnswers(deps.db), kubernetes: await deps.kube.ping() };
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
  });
}
