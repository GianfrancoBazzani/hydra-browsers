import { describe, expect, it } from 'vitest';
import { livePodNames, sessionPodName } from './session-logs.js';

describe('livePodNames', () => {
  it('keeps the pods that are not being deleted', () => {
    expect(
      livePodNames({
        items: [
          { metadata: { name: 'session-a-0' } },
          { metadata: { name: 'session-b-0', deletionTimestamp: '2026-10-12T16:00:00Z' } },
          { metadata: { name: 'session-c-0' } },
        ],
      }),
    ).toEqual(['session-a-0', 'session-c-0']);
  });
});

describe('sessionPodName', () => {
  it('is the pod of the StatefulSet of the session', () => {
    expect(sessionPodName('kqjoufqzd5mq')).toBe('session-kqjoufqzd5mq-0');
  });
});
