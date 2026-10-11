/** A live ticket can be used one time, in the first 60 s (spec section 9.2). */
export const LIVE_TICKET_TTL_MS = 60_000;
/** A live grant ends 12 h after its creation (spec section 9.2). */
export const LIVE_GRANT_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * A live grant ends 30 s after its last WebSocket closes, or 30 s after its creation if no
 * WebSocket opens (spec section 9.2).
 */
export const LIVE_GRANT_IDLE_MS = 30_000;
/** The live connection check runs every 60 s (spec sections 9.2 and 13.3). */
export const LIVE_CHECK_INTERVAL_MS = 60_000;
/** SIGTERM closes the open WebSockets after 10 s (spec section 14). */
export const LIVE_SHUTDOWN_GRACE_MS = 10_000;
/** The Neko HTTP and WebSocket port of a session pod (spec section 7.3). */
export const NEKO_PORT = 8080;
/** Time limit to connect to the pod for an upgrade. It is not a limit on open WebSockets. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
