import type { ChoiceId, PlayerId, RacerId } from './ids.js';
import type { Token } from './scoring.js';
import type { RaceNumber } from './tracks/index.js';

/**
 * Everything that observably happened, in order.
 *
 * Events are the engine's output channel and they carry real weight:
 *
 *  - the client animates from them, one hop per event, rather than snapping between
 *    states — which is the only way an ability chain reads as cause-and-effect;
 *  - the human-readable game log is generated from them, for free;
 *  - a reconnecting client can be caught up by replaying events since its last `step`
 *    instead of receiving a whole snapshot.
 *
 * Because of the first point, movement emits one `racer/moved` per space traversed, never
 * a single jump to the destination. A warp is deliberately a different event: the rules say
 * it "doesn't count as moving", so the client snaps rather than animating a hop.
 */

export interface PlayerJoined {
  readonly t: 'player/joined';
  readonly player: PlayerId;
  readonly name: string;
}

export interface PlayerLeft {
  readonly t: 'player/left';
  readonly player: PlayerId;
}

export interface GameStarted {
  readonly t: 'game/started';
  readonly seatOrder: readonly PlayerId[];
}

export interface DraftRolled {
  readonly t: 'draft/rolled';
  readonly player: PlayerId;
  readonly value: number;
}

export interface DraftOrderSet {
  readonly t: 'draft/orderSet';
  readonly order: readonly PlayerId[];
}

export interface DraftPicked {
  readonly t: 'draft/picked';
  readonly player: PlayerId;
  readonly racerId: RacerId;
}

export interface RaceStarted {
  readonly t: 'race/started';
  readonly raceNo: RaceNumber;
  readonly trackId: string;
}

/** Who leads off the next race, and why. */
export interface TurnOrderSet {
  readonly t: 'turnOrder/set';
  readonly raceNo: RaceNumber;
  readonly first: PlayerId;
  /** 'rolloff' for race 1; 'trailing' for the farthest-behind rule thereafter. */
  readonly reason: 'rolloff' | 'trailing';
}

/** Fired for all players at once when the last commit lands. */
export interface RacersRevealed {
  readonly t: 'race/revealed';
  readonly picks: readonly { readonly player: PlayerId; readonly racerId: RacerId }[];
}

/**
 * A roll-off for who goes first.
 *
 * Used for race 1 only; races 2-4 use the farthest-behind rule instead. Also used as a
 * fallback when no trailing racer can be identified, e.g. a 2-player race where both
 * racers crossed the line.
 */
export interface TurnOrderRolled {
  readonly t: 'turnOrder/rolled';
  readonly raceNo: RaceNumber;
  readonly rolls: readonly { readonly player: PlayerId; readonly value: number }[];
  readonly first: PlayerId;
}

export interface TurnBegan {
  readonly t: 'turn/began';
  readonly player: PlayerId;
  readonly racerId: RacerId;
}

export interface DiceRolled {
  readonly t: 'dice/rolled';
  readonly player: PlayerId;
  readonly racerId: RacerId;
  readonly value: number;
  /** Set when an ability replaced or modified the roll, for log clarity. */
  readonly modifiedBy?: RacerId;
}

/**
 * One space of movement. Emitted per step, including for forced and backward movement.
 */
export interface RacerMoved {
  readonly t: 'racer/moved';
  readonly racerId: RacerId;
  readonly from: number;
  readonly to: number;
  readonly reason: 'main' | 'power' | 'space';
}

/** A racer completed a move having started behind `passed` and ended ahead of them. */
export interface RacerPassed {
  readonly t: 'racer/passed';
  readonly racerId: RacerId;
  readonly passed: RacerId;
}

/**
 * A racer was relocated without moving.
 *
 * "When a racer warps, put their token on the new space, but don't count it as moving for
 * triggering powers, passing racers, etc." — so this is deliberately distinct from
 * `racer/moved`, and the client should snap rather than animate a hop.
 */
export interface RacerWarped {
  readonly t: 'racer/warped';
  readonly racerId: RacerId;
  readonly to: number;
}

export interface RacerTripped {
  readonly t: 'racer/tripped';
  readonly racerId: RacerId;
  readonly by: RacerId | null;
}

export interface RacerStoodUp {
  readonly t: 'racer/stoodUp';
  readonly racerId: RacerId;
}

export interface RacerEliminated {
  readonly t: 'racer/eliminated';
  readonly racerId: RacerId;
  readonly by: RacerId | null;
}

export interface AbilityTriggered {
  readonly t: 'ability/triggered';
  readonly racerId: RacerId;
  /** Which hook fired, for debugging and for the log. */
  readonly hook: string;
  /** Pre-rendered human-readable line, e.g. "Banana trips Centaur!". */
  readonly text: string;
}

export interface DecisionRequested {
  readonly t: 'decision/requested';
  readonly player: PlayerId;
  readonly source: RacerId;
  readonly prompt: string;
}

export interface DecisionMade {
  readonly t: 'decision/made';
  readonly player: PlayerId;
  readonly choice: ChoiceId;
  readonly label: string;
  /** True when the turn timer chose for them. */
  readonly auto: boolean;
}

export interface TokenAwarded {
  readonly t: 'token/awarded';
  readonly player: PlayerId;
  readonly token: Token;
}

/** Point chips handed back, e.g. Sisyphus rolling a 6. Never takes a cup. */
export interface TokenLost {
  readonly t: 'token/lost';
  readonly player: PlayerId;
  readonly value: number;
}

export interface RacerFinished {
  readonly t: 'racer/finished';
  readonly racerId: RacerId;
  readonly player: PlayerId;
  readonly rank: number;
}

export interface RaceEnded {
  readonly t: 'race/ended';
  readonly raceNo: RaceNumber;
  /** Empty if the race ended by stalemate rather than by two racers finishing. */
  readonly podium: readonly PlayerId[];
  readonly byStalemate: boolean;
}

export interface GameEnded {
  readonly t: 'game/ended';
  readonly winners: readonly PlayerId[];
  readonly finalScores: Readonly<Record<PlayerId, number>>;
}

export type GameEvent =
  | PlayerJoined
  | PlayerLeft
  | GameStarted
  | DraftRolled
  | DraftOrderSet
  | DraftPicked
  | RaceStarted
  | RacersRevealed
  | TurnOrderRolled
  | TurnOrderSet
  | TurnBegan
  | DiceRolled
  | RacerMoved
  | RacerPassed
  | RacerWarped
  | RacerTripped
  | RacerStoodUp
  | RacerEliminated
  | AbilityTriggered
  | DecisionRequested
  | DecisionMade
  | TokenAwarded
  | TokenLost
  | RacerFinished
  | RaceEnded
  | GameEnded;

export type GameEventType = GameEvent['t'];
