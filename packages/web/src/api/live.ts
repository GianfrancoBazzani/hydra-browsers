import { LiveTicketResponseSchema } from '@hydra/shared';
import { apiRequest } from './client';

/** Step 1 of the open flow (spec section 9.2): a one-use URL for the iframe. */
export async function createLiveTicket(sid: string, signal?: AbortSignal): Promise<string> {
  const response = await apiRequest(`/api/sessions/${sid}/live-ticket`, {
    method: 'POST',
    schema: LiveTicketResponseSchema,
    ...(signal ? { signal } : {}),
  });
  return response.url;
}

/** Ends the live grants of this login session for the session (spec section 9.2). */
export async function endLiveGrant(sid: string): Promise<void> {
  await apiRequest(`/api/sessions/${sid}/live-grant`, { method: 'DELETE' });
}
