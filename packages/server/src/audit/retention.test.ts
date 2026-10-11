import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { createTestDb, type TestDb } from '../../test/helpers/db.js';
import { auditEvents } from '../db/schema.js';
import { runAuditRetention } from './retention.js';

const DAY = 24 * 60 * 60 * 1000;

describe('runAuditRetention', () => {
  let testDb: TestDb;
  const clock = new FakeClock(1000 * DAY);

  beforeEach(() => {
    testDb = createTestDb(clock);
    for (const age of [91 * DAY, 90 * DAY + 1, 90 * DAY, 10 * DAY, 0]) {
      testDb.db
        .insert(auditEvents)
        .values({ ts: clock.now() - age, kind: 'auth.login', actorType: 'system', data: { age } })
        .run();
    }
  });
  afterEach(() => {
    testDb.close();
  });

  it('deletes the events older than the retention days and returns the count', () => {
    expect(runAuditRetention({ db: testDb.db, clock }, 90)).toBe(2);
    const ages = testDb.db
      .select()
      .from(auditEvents)
      .all()
      .map((row) => row.data.age);
    expect(ages).toEqual([90 * DAY, 10 * DAY, 0]);
  });

  it('deletes nothing when all events are new enough', () => {
    expect(runAuditRetention({ db: testDb.db, clock }, 365)).toBe(0);
  });
});
