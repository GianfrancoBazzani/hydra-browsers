import type { SessionState } from '@hydra/shared';
import { cx } from './cx';

/** Visible names of the session states. */
export const SESSION_STATE_LABELS: Record<SessionState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  error: 'Error',
  deleting: 'Deleting',
  deleted: 'Deleted',
};

const DOT_CLASSES: Record<SessionState, string> = {
  running: 'bg-os-green border-os-green-accessible',
  starting: 'bg-os-yellow border-os-yellow-accessible',
  stopping: 'bg-os-yellow border-os-yellow-accessible',
  stopped: 'bg-os-gray border-os-gray-accessible',
  error: 'bg-os-red border-os-red-accessible',
  deleting: 'bg-os-gray border-os-gray-accessible',
  deleted: 'bg-os-gray border-os-gray-accessible',
};

export interface StatusDotProps {
  state: SessionState;
  /** Shows the state name next to the dot. Without it, the name is visually hidden. */
  showLabel?: boolean;
}

export function StatusDot({ state, showLabel = false }: StatusDotProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        data-state={state}
        className={cx('size-2 shrink-0 rounded-full border', DOT_CLASSES[state])}
      />
      <span className={showLabel ? undefined : 'sr-only'}>{SESSION_STATE_LABELS[state]}</span>
    </span>
  );
}
