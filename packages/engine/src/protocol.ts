/**
 * The wire protocol between a browser and a room.
 *
 * Types only — no runtime code. It lives in the engine package not because it is game
 * logic, but because both the server and the web client already depend on this package,
 * and the two ends must never disagree about a message shape.
 */

import type { Action } from './actions.js';
import type { GameEvent } from './events.js';
import type { PlayerView } from './state.js';

/**
 * Action types a client is permitted to send.
 *
 * Everything else is server-originated: `lobby/join` and `lobby/setConnected` are
 * dispatched when sockets open and close, and `system/timeout` comes only from the room's
 * alarm. Accepting any of those from a client would let a player impersonate the clock.
 */
export const CLIENT_ACTION_TYPES = [
  'lobby/start',
  'lobby/leave',
  'draft/roll',
  'draft/pick',
  'race/commit',
  'race/roll',
  'race/decide',
  'race/continue',
] as const satisfies readonly Action['t'][];

export type ClientActionType = (typeof CLIENT_ACTION_TYPES)[number];

/**
 * An action as the client sends it: without `by`.
 *
 * The server stamps `by` from the socket's authenticated identity. A client-supplied `by`
 * would be trusted input naming who is acting, which is exactly the thing that must not
 * be trusted.
 */
export type ClientAction = Extract<Action, { t: ClientActionType }> extends infer A
  ? A extends { by: unknown }
    ? Omit<A, 'by'>
    : never
  : never;

// --- Client -> server --------------------------------------------------------

export type ClientMessage = { readonly t: 'action'; readonly action: ClientAction };

// --- Server -> client --------------------------------------------------------

/**
 * A full snapshot for one player, plus what just happened and what they may do next.
 *
 * `legal` is computed server-side from the authoritative state. The client renders its
 * buttons from it rather than re-deriving legality, so there is only ever one
 * implementation of the rules deciding what is allowed.
 */
export interface StateMessage {
  readonly t: 'state';
  readonly view: PlayerView;
  /** Events produced by the action that caused this message; empty on connect. */
  readonly events: readonly GameEvent[];
  readonly legal: readonly ClientAction[];
  /** Seconds per turn in this room, for rendering the countdown. 0 means no timer. */
  readonly turnSeconds: number;
}

export interface ErrorMessage {
  readonly t: 'error';
  readonly code: ErrorCode;
  readonly message: string;
}

export type ServerMessage = StateMessage | ErrorMessage;

export type ErrorCode =
  | 'bad_request'
  | 'bad_credentials'
  | 'room_not_found'
  | 'room_full'
  | 'game_in_progress'
  | 'illegal_action'
  | 'internal';

/**
 * WebSocket close codes, in the 4000-4999 range reserved for applications.
 *
 * A browser cannot read the HTTP status of a failed upgrade, so rejections are delivered
 * by accepting the socket, sending an `ErrorMessage`, then closing with one of these —
 * both of which the client *can* read.
 */
export const CLOSE_CODES = {
  bad_request: 4000,
  bad_credentials: 4001,
  room_full: 4003,
  game_in_progress: 4003,
  room_not_found: 4004,
} as const;

// --- HTTP ---------------------------------------------------------------------

export interface CreateRoomRequest {
  /** Per-decision time limit. 0 disables the clock. Defaults server-side. */
  readonly turnSeconds?: number;
}

export interface CreateRoomResponse {
  readonly code: string;
}

export interface RoomInfoResponse {
  readonly code: string;
  readonly exists: boolean;
  readonly phase: PlayerView['phase']['t'] | null;
  readonly playerCount: number;
  readonly maxPlayers: number;
  /** A game in progress refuses new players, but existing players may reconnect. */
  readonly joinable: boolean;
}
