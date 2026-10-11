import type { DesiredState, SessionState } from '@hydra/shared';
import type { PodObservation } from './pod-status.js';

/** Rule 4 of spec section 7.9. */
export const START_TIMEOUT_MS = 120_000;

export interface StateInput {
  state: SessionState;
  desiredState: DesiredState;
  startedAt: number | null;
  readyAt: number | null;
  mediaPort: number | null;
  pod: PodObservation;
  /** desired_state = deleted only: no object of the session and no pod exists. */
  allObjectsGone: boolean;
  now: number;
}

export interface StatePatch {
  state?: SessionState;
  readyAt?: number;
  errorReason?: string;
  desiredState?: 'stopped';
  deletedAt?: number;
  mediaPort?: null;
}

export interface StatePlan {
  /**
   * The rule of spec section 7.9 step 2 that matched (1 to 7). 0: no rule matches (a session in
   * `error` while a pod still exists; rule 6 does not apply to it).
   */
  rule: number;
  /** The fields to write. An empty object: no change. */
  patch: StatePatch;
  /** Rule 7: delete media-<sid> first, then write mediaPort = null (spec section 7.8). */
  releasePort: boolean;
}

function error(rule: number, reason: string): StatePlan {
  return {
    rule,
    patch: { state: 'error', errorReason: reason, desiredState: 'stopped' },
    releasePort: false,
  };
}

/** Step 2 of spec section 7.9: the first rule that matches. Pure, so the tests cover each rule. */
export function decideState(input: StateInput): StatePlan {
  const { state, pod, now } = input;
  if (input.desiredState === 'deleted') {
    if (state === 'deleted') return { rule: 1, patch: {}, releasePort: false };
    if (!input.allObjectsGone)
      return {
        rule: 1,
        patch: state === 'deleting' ? {} : { state: 'deleting' },
        releasePort: false,
      };
    return {
      rule: 1,
      patch: { state: 'deleted', deletedAt: now, mediaPort: null },
      releasePort: false,
    };
  }
  if (input.desiredState === 'running') {
    if (pod.ready) {
      const patch: StatePatch = {};
      if (state !== 'running') patch.state = 'running';
      if (input.readyAt === null) patch.readyAt = now;
      return { rule: 2, patch, releasePort: false };
    }
    if (pod.waitingError) return error(3, pod.waitingError);
    if (
      input.readyAt === null &&
      input.startedAt !== null &&
      now - input.startedAt > START_TIMEOUT_MS
    ) {
      const detail = pod.notReadyReason ?? (pod.exists ? 'the pod is not Ready' : 'no pod exists');
      return error(
        4,
        `Timeout: the pod was not Ready ${START_TIMEOUT_MS / 1000} s after the start (${detail})`,
      );
    }
    return {
      rule: 5,
      patch: state === 'starting' ? {} : { state: 'starting' },
      releasePort: false,
    };
  }
  // desired_state = stopped.
  if (pod.exists) {
    // Rule 6 does not apply to `error`: the state stays `error`, and error_reason does not change.
    // Rule 7 releases the media port when the pod is gone. The user then clicks Retry start.
    if (state === 'error') return { rule: 0, patch: {}, releasePort: false };
    return {
      rule: 6,
      patch: state === 'stopping' ? {} : { state: 'stopping' },
      releasePort: false,
    };
  }
  const patch: StatePatch = {};
  if (state !== 'stopped' && state !== 'error') patch.state = 'stopped';
  if (input.mediaPort !== null) patch.mediaPort = null;
  return { rule: 7, patch, releasePort: input.mediaPort !== null };
}
