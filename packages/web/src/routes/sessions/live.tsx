import type { Screen, SessionResource, SessionState } from '@hydra/shared';
import { MESSAGES } from '@hydra/shared';
import { IconMaximize } from '@tabler/icons-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { errorMessage } from '../../api/client';
import { createLiveTicket } from '../../api/live';
import { useSessionAction } from '../../api/sessions';
import { Banner, Button, IconButton, OsIcon, StatusDot } from '../../components/os';
import { useEventsReconnectCount } from '../../lib/events';
import { formatAgentCount, formatToolCall, permitsAllDomains } from '../../lib/format';
import { useLiveTab } from '../../lib/live-tab';
import { useIsRecent } from '../../lib/use-recent';
import { useSessionResource } from './outlet';

/** "Agent active" while the last tool call started less than 10 s ago (spec section 9.4). */
export const AGENT_ACTIVE_MS = 10_000;

/** The iframe attributes of spec section 9.4. */
export const LIVE_IFRAME_ALLOW = 'clipboard-read; clipboard-write; fullscreen; autoplay';
export const LIVE_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';

const SCREEN_SIZES: Record<Screen, { width: number; height: number }> = {
  '1280x720': { width: 1280, height: 720 },
  '1600x900': { width: 1600, height: 900 },
  '1920x1080': { width: 1920, height: 1080 },
};

const STATE_TEXT: Record<SessionState, string> = {
  stopped: 'The session is stopped.',
  starting: 'The session is starting. The live view opens when it is running.',
  running: 'The session is running.',
  stopping: 'The session is stopping.',
  error: 'The session could not start.',
  deleting: 'The session is being deleted.',
  deleted: 'The session was deleted.',
};

interface TicketState {
  key: string;
  url: string | null;
  error: string | null;
}

/**
 * The open flow of spec section 9.2: end the grant of the previous session of this browser
 * tab, then get a one-use ticket URL. A new `renewKey` gets a new ticket.
 */
function useLiveTicket(
  sid: string,
  renewKey: string,
): { url: string | null; error: string | null } {
  const tab = useLiveTab();
  const [ticket, setTicket] = useState<TicketState>({ key: '', url: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    const cancelled = () => controller.signal.aborted;
    const open = async () => {
      try {
        await tab.beforeOpen(sid);
        if (cancelled()) return;
        const url = await createLiveTicket(sid, controller.signal);
        if (cancelled()) return;
        tab.opened(sid);
        setTicket({ key: renewKey, url, error: null });
      } catch (error) {
        if (!cancelled()) setTicket({ key: renewKey, url: null, error: errorMessage(error) });
      }
    };
    void open();
    return () => {
      controller.abort();
    };
  }, [tab, sid, renewKey]);

  return ticket.key === renewKey ? ticket : { url: null, error: null };
}

function LiveStage({
  session,
  stageRef,
}: {
  session: SessionResource;
  stageRef: RefObject<HTMLDivElement | null>;
}) {
  const reconnects = useEventsReconnectCount();
  const [attempt, setAttempt] = useState(0);
  // A new Neko profile (live.control), an SSE reconnect, or "Try again" needs a new ticket.
  const profile = session.rights.includes('live.control') ? 'control' : 'watch';
  const ticket = useLiveTicket(session.id, `${profile}:${String(reconnects)}:${String(attempt)}`);
  const { width, height } = SCREEN_SIZES[session.settings.screen];

  return (
    <div
      ref={stageRef}
      data-testid="live-stage"
      className="@container-size grid min-h-0 flex-1 place-items-center bg-os-black"
    >
      {ticket.url ? (
        <iframe
          key={ticket.url}
          title={`Live view of ${session.name}`}
          src={ticket.url}
          allow={LIVE_IFRAME_ALLOW}
          sandbox={LIVE_IFRAME_SANDBOX}
          className="block border-0"
          style={{
            aspectRatio: `${String(width)} / ${String(height)}`,
            width: `min(100cqw, calc(100cqh * ${String(width)} / ${String(height)}))`,
          }}
        />
      ) : ticket.error ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <p role="alert" className="text-os-base text-os-on-fill">
            {ticket.error}
          </p>
          <Button
            variant="primary"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="text-os-base text-os-on-fill">
          Connecting…
        </p>
      )}
    </div>
  );
}

function NotRunning({ session }: { session: SessionResource }) {
  const action = useSessionAction(session.id);
  const { state } = session;
  const canStart =
    session.rights.includes('session.lifecycle') && (state === 'stopped' || state === 'error');
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-os-surface p-6">
      <div className="flex max-w-120 flex-col items-center gap-3 text-center">
        <StatusDot state={state} showLabel />
        <p className="text-os-base text-os-foreground">{STATE_TEXT[state]}</p>
        {state === 'error' && session.errorReason ? (
          <p className="font-mono text-os-sm break-all text-os-red-accessible">
            {session.errorReason}
          </p>
        ) : null}
        {canStart ? (
          <Button
            variant="primary"
            disabled={action.isPending}
            onClick={() => {
              action.mutate('start');
            }}
          >
            {state === 'error' ? 'Retry start' : 'Start'}
          </Button>
        ) : null}
        {action.error ? (
          <p role="alert" className="text-os-base text-os-red-accessible">
            {errorMessage(action.error)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The Live view (spec sections 9.4 and 10.2). */
export function LiveView() {
  const session = useSessionResource();
  const stageRef = useRef<HTMLDivElement>(null);
  const { activeAgentCount, lastToolCall } = session.agentActivity;
  const agentActive = useIsRecent(lastToolCall?.startedAt ?? null, AGENT_ACTIVE_MS);
  const running = session.state === 'running';
  const allowAll = permitsAllDomains(session.settings.allowlist);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {agentActive || activeAgentCount > 1 || allowAll ? (
        <div className="flex flex-col gap-2 border-b border-os-separator p-3">
          {agentActive ? <Banner variant="info">{MESSAGES.agentActive}</Banner> : null}
          {activeAgentCount > 1 ? (
            <Banner variant="warning">{MESSAGES.multipleAgents}</Banner>
          ) : null}
          {allowAll ? <Banner variant="warning">{MESSAGES.allowAll}</Banner> : null}
        </div>
      ) : null}
      {running ? (
        <LiveStage key={session.id} session={session} stageRef={stageRef} />
      ) : (
        <NotRunning session={session} />
      )}
      <div className="flex h-(--os-statusbar-height) shrink-0 items-center gap-4 border-t border-os-separator bg-os-surface px-3 text-os-xs text-os-gray-accessible">
        <span>{formatAgentCount(activeAgentCount)}</span>
        <span className="min-w-0 flex-1 truncate font-mono">
          {lastToolCall ? formatToolCall(lastToolCall) : 'No tool call yet'}
        </span>
        <IconButton
          aria-label="Full screen"
          disabled={!running}
          onClick={() => {
            stageRef.current?.requestFullscreen().catch(() => undefined);
          }}
        >
          <OsIcon icon={IconMaximize} />
        </IconButton>
      </div>
    </div>
  );
}
