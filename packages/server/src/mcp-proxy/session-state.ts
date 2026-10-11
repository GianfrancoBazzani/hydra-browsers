// Reads the state of a session for the MCP endpoint (spec section 8.2 step 2).
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';

/** True if the session row exists and its state is running. */
export function isSessionRunning(db: Db, sessionId: string): boolean {
  const row = db
    .select({ state: sessions.state })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  return row?.state === 'running';
}
