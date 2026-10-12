export { parseSidecarArgs, type SidecarOptions } from './args.js';
export { CdpBrowser, CDP_RETRY_MS } from './browser.js';
export { currentTabIndex, tabLineMatchesUrl } from './current-tab.js';
export { ELEMENT_TIMEOUT_MS, vaultFill } from './fill.js';
export {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  INTERNAL_ID_PREFIX,
  InterceptingTransport,
  toolError,
  type FillHandler,
  type ToolResult,
} from './interceptor.js';
export { NOT_CONNECTED_BODY, SESSION_IDLE_MS, SidecarServer, type SessionHooks } from './server.js';
