import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createSessionEventStream, createUserEventStream } from './sse';

/** Counts the reconnects of the user SSE stream. The Live view gets a new ticket when it changes. */
const ReconnectCountContext = createContext(0);

/** Keeps GET /api/events open while the user is logged in (spec section 10.3). */
export function UserEventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [reconnects, setReconnects] = useState(0);

  useEffect(() => {
    const stream = createUserEventStream(queryClient, {
      onReconnect: () => {
        setReconnects((count) => count + 1);
      },
    });
    stream.start();
    const wake = () => {
      if (document.visibilityState === 'visible') stream.ensureOpen();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      stream.stop();
    };
  }, [queryClient]);

  return <ReconnectCountContext value={reconnects}>{children}</ReconnectCountContext>;
}

export function useEventsReconnectCount(): number {
  return useContext(ReconnectCountContext);
}

/** Keeps GET /api/sessions/<sid>/events open while the Activity view is open. */
export function useSessionEvents(sid: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const stream = createSessionEventStream(queryClient, sid);
    stream.start();
    const wake = () => {
      if (document.visibilityState === 'visible') stream.ensureOpen();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      stream.stop();
    };
  }, [queryClient, sid]);
}
