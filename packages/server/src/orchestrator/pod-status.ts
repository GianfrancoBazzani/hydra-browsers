import type { V1Pod, V1PodCondition } from '@kubernetes/client-node';
import { STARTED_AT_ANNOTATION } from './names.js';
import type { KubeObject } from './types.js';

/** Container wait reasons that make a session go to `error` (spec section 7.9, rule 3). */
export const ERROR_WAIT_REASONS: ReadonlySet<string> = new Set([
  'CrashLoopBackOff',
  'ErrImagePull',
  'ImagePullBackOff',
  'CreateContainerConfigError',
  'InvalidImageName',
]);

export interface PodObservation {
  /** A pod exists: also a terminating pod, or a pod of an older start (rules 6 and 7). */
  exists: boolean;
  /**
   * The pod of the current start: its `hydra/started-at` annotation equals `started_at`. Restart
   * changes the annotation, so the old pod does not count as Ready while the StatefulSet replaces it.
   */
  current: boolean;
  /** The current pod is not terminating and its Ready condition is True (rule 2). */
  ready: boolean;
  /** `<reason>: <message>` of the first container of the current pod that waits with an error reason (rule 3). */
  waitingError: string | null;
  /** `<reason>: <message>` of the first condition of the current pod that is not True (text for rule 4). */
  notReadyReason: string | null;
}

const NO_POD: PodObservation = {
  exists: false,
  current: false,
  ready: false,
  waitingError: null,
  notReadyReason: null,
};

function conditionText(condition: V1PodCondition): string {
  const reason = condition.reason ?? `${condition.type}=${condition.status}`;
  return condition.message ? `${reason}: ${condition.message}` : reason;
}

export function observePod(object: KubeObject | null, startedAt: number | null): PodObservation {
  if (!object) return NO_POD;
  const pod = object as V1Pod & KubeObject;
  const annotation = pod.metadata.annotations?.[STARTED_AT_ANNOTATION];
  const current = annotation === String(startedAt ?? 0);
  if (!current) return { ...NO_POD, exists: true };
  const terminating = Boolean(pod.metadata.deletionTimestamp);
  const conditions = pod.status?.conditions ?? [];
  const ready = !terminating && conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  let waitingError: string | null = null;
  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason && ERROR_WAIT_REASONS.has(waiting.reason)) {
      waitingError = waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
      break;
    }
  }
  const scheduled = conditions.find((c) => c.type === 'PodScheduled' && c.status !== 'True');
  const notReady = scheduled ?? conditions.find((c) => c.type === 'Ready' && c.status !== 'True');
  return {
    exists: true,
    current,
    ready,
    waitingError,
    notReadyReason: notReady ? conditionText(notReady) : null,
  };
}
