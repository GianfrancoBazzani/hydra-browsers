import type { Action } from '@hydra/shared';

/** The five views of a session and the right that each view needs (spec sections 6.5, 10.2). */
export const SESSION_VIEWS = [
  { value: 'live', label: 'Live', right: 'live.watch' },
  { value: 'tokens', label: 'Tokens', right: 'token.create' },
  { value: 'sharing', label: 'Sharing', right: 'session.read' },
  { value: 'activity', label: 'Activity', right: 'audit.read' },
  { value: 'settings', label: 'Settings', right: 'session.read' },
] as const satisfies readonly { value: string; label: string; right: Action }[];

export type SessionViewDef = (typeof SESSION_VIEWS)[number];
export type SessionView = SessionViewDef['value'];

export function allowedViews(rights: readonly Action[]): SessionViewDef[] {
  return SESSION_VIEWS.filter((view) => rights.includes(view.right));
}

/** The view of a path like /sessions/<sid>/tokens, or null. */
export function viewFromPath(pathname: string): SessionView | null {
  const last = pathname.split('/').filter(Boolean).at(-1);
  return SESSION_VIEWS.find((view) => view.value === last)?.value ?? null;
}
