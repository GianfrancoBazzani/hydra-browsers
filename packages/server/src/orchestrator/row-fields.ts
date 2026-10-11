import type { DesiredState, Screen, SessionState } from '@hydra/shared';

/*
 * Typed reads of the text enum columns of SessionRow. The parameters are `string`, so the code
 * compiles and lints the same way whether db/schema.ts types these columns as text or as enums.
 */
export const stateOf = (row: { state: string }): SessionState => row.state as SessionState;
export const desiredStateOf = (row: { desiredState: string }): DesiredState =>
  row.desiredState as DesiredState;
export const screenOf = (row: { screen: string }): Screen => row.screen as Screen;
