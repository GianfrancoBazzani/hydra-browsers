import { describe, expect, it } from 'vitest';
import type { PodObservation } from './pod-status.js';
import { decideState, START_TIMEOUT_MS, type StateInput } from './state-rules.js';

const noPod: PodObservation = {
  exists: false,
  current: false,
  ready: false,
  waitingError: null,
  notReadyReason: null,
};
const readyPod: PodObservation = {
  exists: true,
  current: true,
  ready: true,
  waitingError: null,
  notReadyReason: null,
};
const startingPod: PodObservation = {
  exists: true,
  current: true,
  ready: false,
  waitingError: null,
  notReadyReason: 'ContainersNotReady: x',
};
const now = 1_000_000;

function input(fields: Partial<StateInput>): StateInput {
  return {
    state: 'starting',
    desiredState: 'running',
    startedAt: now - 1_000,
    readyAt: null,
    mediaPort: 52000,
    pod: noPod,
    allObjectsGone: false,
    now,
    ...fields,
  };
}

describe('decideState (spec section 7.9 step 2)', () => {
  it('rule 1: deleting while objects remain', () => {
    expect(
      decideState(input({ desiredState: 'deleted', state: 'running', pod: readyPod })),
    ).toEqual({
      rule: 1,
      patch: { state: 'deleting' },
      releasePort: false,
    });
    expect(decideState(input({ desiredState: 'deleted', state: 'deleting' })).patch).toEqual({});
  });

  it('rule 1: deleted when all objects are gone', () => {
    expect(
      decideState(input({ desiredState: 'deleted', state: 'deleting', allObjectsGone: true })),
    ).toEqual({
      rule: 1,
      patch: { state: 'deleted', deletedAt: now, mediaPort: null },
      releasePort: false,
    });
    expect(
      decideState(input({ desiredState: 'deleted', state: 'deleted', allObjectsGone: true })).patch,
    ).toEqual({});
  });

  it('rule 2: running when the pod is Ready, ready_at set once', () => {
    expect(decideState(input({ pod: readyPod }))).toEqual({
      rule: 2,
      patch: { state: 'running', readyAt: now },
      releasePort: false,
    });
    expect(decideState(input({ state: 'running', readyAt: 5, pod: readyPod })).patch).toEqual({});
  });

  it('rule 3: error for a container wait reason', () => {
    const pod: PodObservation = { ...startingPod, waitingError: 'ImagePullBackOff: pull failed' };
    expect(decideState(input({ pod }))).toEqual({
      rule: 3,
      patch: {
        state: 'error',
        errorReason: 'ImagePullBackOff: pull failed',
        desiredState: 'stopped',
      },
      releasePort: false,
    });
  });

  it('rule 3 applies also after the pod was Ready', () => {
    const pod: PodObservation = { ...startingPod, waitingError: 'CrashLoopBackOff: back-off' };
    expect(decideState(input({ state: 'running', readyAt: 5, pod })).rule).toBe(3);
  });

  it('rule 4: error 120 s after the start while ready_at is null', () => {
    const plan = decideState(input({ startedAt: now - START_TIMEOUT_MS - 1, pod: startingPod }));
    expect(plan.rule).toBe(4);
    expect(plan.patch).toEqual({
      state: 'error',
      errorReason: 'Timeout: the pod was not Ready 120 s after the start (ContainersNotReady: x)',
      desiredState: 'stopped',
    });
  });

  it('rule 4 does not apply at exactly 120 s, or when ready_at is set', () => {
    expect(decideState(input({ startedAt: now - START_TIMEOUT_MS, pod: startingPod })).rule).toBe(
      5,
    );
    expect(
      decideState(input({ startedAt: now - START_TIMEOUT_MS - 1, readyAt: 5, pod: noPod })).rule,
    ).toBe(5);
  });

  it('rule 4 names a missing pod', () => {
    const plan = decideState(input({ startedAt: now - START_TIMEOUT_MS - 1 }));
    expect(plan.patch.errorReason).toBe(
      'Timeout: the pod was not Ready 120 s after the start (no pod exists)',
    );
  });

  it('rule 5: starting, also for a pod that fails after it was Ready', () => {
    expect(decideState(input({ state: 'stopped', pod: startingPod }))).toEqual({
      rule: 5,
      patch: { state: 'starting' },
      releasePort: false,
    });
    expect(decideState(input({ state: 'running', readyAt: 5, pod: startingPod })).patch).toEqual({
      state: 'starting',
    });
  });

  it('rule 6: stopping while a pod exists', () => {
    expect(
      decideState(input({ desiredState: 'stopped', state: 'running', pod: readyPod })),
    ).toEqual({
      rule: 6,
      patch: { state: 'stopping' },
      releasePort: false,
    });
  });

  it('rule 6 does not apply to error: no rule matches, the state and error_reason stay', () => {
    expect(
      decideState(input({ desiredState: 'stopped', state: 'error', pod: startingPod })),
    ).toEqual({ rule: 0, patch: {}, releasePort: false });
    const oldPod: PodObservation = { ...readyPod, current: false, ready: false };
    expect(decideState(input({ desiredState: 'stopped', state: 'error', pod: oldPod }))).toEqual({
      rule: 0,
      patch: {},
      releasePort: false,
    });
  });

  it('rule 7: stopped and the media port is released', () => {
    expect(decideState(input({ desiredState: 'stopped', state: 'stopping' }))).toEqual({
      rule: 7,
      patch: { state: 'stopped', mediaPort: null },
      releasePort: true,
    });
  });

  it('rule 7 keeps the error state and releases the port', () => {
    expect(decideState(input({ desiredState: 'stopped', state: 'error' }))).toEqual({
      rule: 7,
      patch: { mediaPort: null },
      releasePort: true,
    });
  });

  it('rule 7 without a port is no change for a stopped session', () => {
    expect(
      decideState(input({ desiredState: 'stopped', state: 'stopped', mediaPort: null })),
    ).toEqual({
      rule: 7,
      patch: {},
      releasePort: false,
    });
  });
});
