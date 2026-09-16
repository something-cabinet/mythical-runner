import type { Action } from './actions.js';

/**
 * Thrown when an action is not legal in the current state.
 *
 * The server treats this as a client bug or a cheat attempt and rejects the message
 * without mutating anything — `applyAction` never partially applies.
 */
export class IllegalActionError extends Error {
  readonly action: Action;

  constructor(action: Action, reason: string) {
    super(`Illegal action '${action.t}': ${reason}`);
    this.name = 'IllegalActionError';
    this.action = action;
  }
}

/** Internal invariant failure — always an engine bug, never a client's fault. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EngineError(message);
}
