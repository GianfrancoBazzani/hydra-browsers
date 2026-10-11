import { createContext, useContext, useState, type ReactNode } from 'react';
import { endLiveGrant } from '../api/live';

/**
 * Remembers the session of the live view of this browser tab. Before the tab opens the live
 * view of another session, it ends the grant of the previous one (spec section 9.2).
 */
export class LiveTabRegistry {
  private readonly endGrant: (sid: string) => Promise<void>;
  private lastSid: string | null = null;
  private ending: Promise<void> = Promise.resolve();

  constructor(endGrant: (sid: string) => Promise<void>) {
    this.endGrant = endGrant;
  }

  /** Resolves when the grant of the previous session (if it is not `sid`) has ended. */
  beforeOpen(sid: string): Promise<void> {
    const previous = this.lastSid;
    if (previous !== null && previous !== sid) {
      this.lastSid = null;
      this.ending = this.endGrant(previous).catch(() => undefined);
    }
    return this.ending;
  }

  opened(sid: string): void {
    this.lastSid = sid;
  }
}

const LiveTabContext = createContext<LiveTabRegistry | null>(null);

export function LiveTabProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new LiveTabRegistry(endLiveGrant));
  return <LiveTabContext value={registry}>{children}</LiveTabContext>;
}

export function useLiveTab(): LiveTabRegistry {
  const registry = useContext(LiveTabContext);
  if (!registry) throw new Error('useLiveTab needs a LiveTabProvider');
  return registry;
}
