/**
 * Safe-mode flag.
 *
 * When schema migrations fail at startup, the API server boots into
 * "safe mode": the database is opened read-only at the application layer
 * (write requests rejected by middleware) so the user can inspect data,
 * back it up, or roll back the app version without further corruption.
 *
 * The flag lives in module-scope state because it tracks the lifecycle of
 * the current process — there's exactly one database handle per process,
 * so one flag is correct. It's reset on `clearSafeMode()` and on process
 * restart.
 */

export interface SafeModeState {
  readonly active: boolean;
  readonly reason: string;
  readonly failedMigrationId: number | null;
  readonly failedAt: number;
}

const INACTIVE: SafeModeState = {
  active: false,
  reason: "",
  failedMigrationId: null,
  failedAt: 0,
};

let _state: SafeModeState = INACTIVE;

export function getSafeMode(): SafeModeState {
  return _state;
}

export function setSafeMode(input: {
  reason: string;
  failedMigrationId: number | null;
}): SafeModeState {
  _state = {
    active: true,
    reason: input.reason,
    failedMigrationId: input.failedMigrationId,
    failedAt: Date.now(),
  };
  return _state;
}

export function clearSafeMode(): SafeModeState {
  _state = INACTIVE;
  return _state;
}
