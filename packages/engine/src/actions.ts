import type { CharacterSetId } from './characters/sets.js';
import type { ChoiceId, PlayerId, RacerId } from './ids.js';

/**
 * Every way the game state can change.
 *
 * A game is fully described by `(seed, Action[])`. Nothing else may mutate state — that
 * is what makes replay tests and client-side prediction possible.
 *
 * `by` is always the acting player. The server verifies it against the connection's
 * authenticated identity before the engine ever sees it; the engine then separately
 * checks the action is legal for that player. Both checks matter: the first stops
 * impersonation, the second stops out-of-turn play.
 */

export interface LobbyJoin {
  readonly t: 'lobby/join';
  readonly by: PlayerId;
  readonly name: string;
}

export interface LobbyLeave {
  readonly t: 'lobby/leave';
  readonly by: PlayerId;
}

export interface LobbySetConnected {
  readonly t: 'lobby/setConnected';
  readonly by: PlayerId;
  readonly connected: boolean;
}

/** Only the host (seatOrder[0]) may start. */
export interface LobbyStart {
  readonly t: 'lobby/start';
  readonly by: PlayerId;
}

/** Host only, lobby only: seats a computer player. The server plays its moves. */
export interface LobbyAddBot {
  readonly t: 'lobby/addBot';
  readonly by: PlayerId;
}

/**
 * Host only, lobby only: adds a character set to the draft deck, or takes it out. The
 * last set can't be taken out.
 */
export interface LobbyToggleSet {
  readonly t: 'lobby/toggleSet';
  readonly by: PlayerId;
  readonly set: CharacterSetId;
}

/** Host only, lobby only: unseats a computer player. */
export interface LobbyRemoveBot {
  readonly t: 'lobby/removeBot';
  readonly by: PlayerId;
  readonly player: PlayerId;
}

/**
 * Any seated player, once the game is over: back to the lobby with the same room, for
 * another game with whoever is still here.
 */
export interface LobbyRematch {
  readonly t: 'lobby/rematch';
  readonly by: PlayerId;
}

/** Roll-off for draft order. Highest unique roll goes first; ties re-roll. */
export interface DraftRoll {
  readonly t: 'draft/roll';
  readonly by: PlayerId;
}

export interface DraftPick {
  readonly t: 'draft/pick';
  readonly by: PlayerId;
  readonly racerId: RacerId;
}

/** Secret until every player has committed. */
export interface RaceCommit {
  readonly t: 'race/commit';
  readonly by: PlayerId;
  readonly racerId: RacerId;
}

export interface RaceRoll {
  readonly t: 'race/roll';
  readonly by: PlayerId;
  /**
   * Which of your racers is going. Optional when only one of them is left to move, which
   * is every turn outside the two-player variant.
   */
  readonly racerId?: RacerId;
}

/**
 * Answer to a PendingDecision. The only legal action in the game while `pending` is set.
 */
export interface RaceDecide {
  readonly t: 'race/decide';
  readonly by: PlayerId;
  readonly choice: ChoiceId;
}

/** Acknowledge the post-race scoreboard and move to the next race. */
export interface RaceContinue {
  readonly t: 'race/continue';
  readonly by: PlayerId;
}

/**
 * Turn-timer expiry. Not issued by a player — the server emits it once `deadline` has
 * passed, and the engine re-validates the deadline before honouring it.
 */
export interface SystemTimeout {
  readonly t: 'system/timeout';
  readonly at: number;
}

export type Action =
  | LobbyJoin
  | LobbyLeave
  | LobbySetConnected
  | LobbyStart
  | LobbyAddBot
  | LobbyRemoveBot
  | LobbyToggleSet
  | LobbyRematch
  | DraftRoll
  | DraftPick
  | RaceCommit
  | RaceRoll
  | RaceDecide
  | RaceContinue
  | SystemTimeout;

export type ActionType = Action['t'];

/** Actions carrying an acting player, i.e. everything except system actions. */
export type PlayerAction = Extract<Action, { by: PlayerId }>;

export function isPlayerAction(action: Action): action is PlayerAction {
  return 'by' in action;
}
