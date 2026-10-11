import { describe, expect, it } from 'vitest';
import { observePod } from './pod-status.js';
import type { KubeObject } from './types.js';

function pod(
  fields: {
    startedAt?: string;
    ready?: boolean;
    waiting?: string;
    terminating?: boolean;
    init?: string;
    scheduled?: boolean;
  } = {},
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'session-abcdefghij23-0',
      namespace: 'hydra-sessions',
      labels: {},
      annotations: { 'hydra/started-at': fields.startedAt ?? '1000' },
      ...(fields.terminating ? { deletionTimestamp: new Date(0) } : {}),
    },
    status: {
      conditions: [
        fields.scheduled === false
          ? {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: '0/1 nodes are available',
            }
          : { type: 'PodScheduled', status: 'True' },
        fields.ready
          ? { type: 'Ready', status: 'True' }
          : {
              type: 'Ready',
              status: 'False',
              reason: 'ContainersNotReady',
              message: 'containers with unready status: [neko]',
            },
      ],
      initContainerStatuses: fields.init
        ? [
            {
              name: 'remove-locks',
              state: { waiting: { reason: fields.init, message: 'init waits' } },
            },
          ]
        : [],
      containerStatuses: [
        {
          name: 'neko',
          state: fields.waiting
            ? { waiting: { reason: fields.waiting, message: 'back-off 10s' } }
            : { running: {} },
        },
      ],
    },
  } as unknown as KubeObject;
}

describe('observePod', () => {
  it('reports no pod', () => {
    expect(observePod(null, 1000)).toEqual({
      exists: false,
      current: false,
      ready: false,
      waitingError: null,
      notReadyReason: null,
    });
  });

  it('reports a Ready pod of the current start', () => {
    expect(observePod(pod({ ready: true }), 1000)).toMatchObject({
      exists: true,
      current: true,
      ready: true,
      waitingError: null,
    });
  });

  it('does not count a pod of an older start as Ready', () => {
    expect(observePod(pod({ ready: true, startedAt: '999' }), 1000)).toEqual({
      exists: true,
      current: false,
      ready: false,
      waitingError: null,
      notReadyReason: null,
    });
  });

  it('does not count a terminating pod as Ready', () => {
    expect(observePod(pod({ ready: true, terminating: true }), 1000).ready).toBe(false);
  });

  it.each([
    'CrashLoopBackOff',
    'ErrImagePull',
    'ImagePullBackOff',
    'CreateContainerConfigError',
    'InvalidImageName',
  ])('reports the wait reason %s', (reason) => {
    expect(observePod(pod({ waiting: reason }), 1000).waitingError).toBe(`${reason}: back-off 10s`);
  });

  it('ignores other wait reasons', () => {
    expect(observePod(pod({ waiting: 'ContainerCreating' }), 1000).waitingError).toBeNull();
  });

  it('reports a wait reason of the init container', () => {
    expect(observePod(pod({ init: 'ImagePullBackOff' }), 1000).waitingError).toBe(
      'ImagePullBackOff: init waits',
    );
  });

  it('gives the scheduling reason first, then the Ready reason', () => {
    expect(observePod(pod({ scheduled: false }), 1000).notReadyReason).toBe(
      'Unschedulable: 0/1 nodes are available',
    );
    expect(observePod(pod({}), 1000).notReadyReason).toBe(
      'ContainersNotReady: containers with unready status: [neko]',
    );
  });

  it('matches started_at null to the annotation 0', () => {
    expect(observePod(pod({ startedAt: '0', ready: true }), null).current).toBe(true);
  });
});
