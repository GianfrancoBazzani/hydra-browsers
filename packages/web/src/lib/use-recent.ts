import { useCallback, useSyncExternalStore } from 'react';

/** True while `timestamp` is less than `windowMs` ago. It changes to false on time. */
export function useIsRecent(timestamp: number | null, windowMs: number): boolean {
  // The value is read from the clock on every render, so a timestamp that is already old when
  // it arrives is false in the same render. A timer re-renders when the window ends, and it is
  // re-armed if it fired early.
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (timestamp === null) return () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        const remaining = timestamp + windowMs - Date.now();
        if (remaining <= 0) return;
        timer = setTimeout(() => {
          onChange();
          // A timer can fire a little early by Date.now(). The snapshot is then still true and
          // nothing subscribes again, so arm a new timer for what is left of the window.
          arm();
        }, remaining);
      };
      arm();
      return () => {
        clearTimeout(timer);
      };
    },
    [timestamp, windowMs],
  );
  const getSnapshot = useCallback(
    () => timestamp !== null && Date.now() - timestamp < windowMs,
    [timestamp, windowMs],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
