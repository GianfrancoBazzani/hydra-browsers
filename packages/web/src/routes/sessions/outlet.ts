import type { SessionResource } from '@hydra/shared';
import { useOutletContext } from 'react-router';

/** The session of the current page. SessionLayout passes it to the views. */
export function useSessionResource(): SessionResource {
  return useOutletContext<SessionResource>();
}
