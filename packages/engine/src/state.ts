import type { ChoiceId, PlayerId, RacerId } from './ids.js';
import type { Token } from './scoring.js';
import type { RaceNumber } from './tracks/index.js';

/** How many racers each player drafts, and therefore how many races there are. */
export const RACERS_PER_PLAYER = 4;
export const RACE_COUNT = 4;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Racers that must cross the line before a race ends. */
export const FINISHERS_PER_RACE = 2;

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  /** A player who has disconnected still holds their seat; the turn timer covers them. */
  readonly connected: boolean;
}

/** One racer's situation during a race. Only committed racers appear on the board. */
export interface RacerState {
  readonly owner: PlayerId;
  readonly racerId: RacerId;
  /** START (-1) .. FINISH (30). See tracks/types.ts. */
  readonly pos: number;
  /** Tripped racers spend their next turn standing up instead of moving. */
  readonly tripped: boolean;
  readonly eliminated: boolean;
  /** Finishing rank, 1-based, or null if still racing. */
  readonly finishedRank: number | null;
  /**
   * Per-character scratch space. Abilities that need to remember something across turns
   * (counters, one-shot flags, suspended-handler continuation keys) store it here rather
   * than in module state, so the whole game stays serializable.
   */
  readonly memo: Readonly<Record<string, unknown>>;
}

/**
 * A choice the engine is blocked on.
 *
 * Abilities frequently need input from a player who is NOT the active player — Duelist's
 * duels, Centaur's kick target, every optional "may" ability. When a handler needs one, it
 * returns a PendingDecision; the engine parks, and the only legal action in the entire game
 * becomes that player's response.
 */
export interface PendingDecision {
  /** Who must answer. Not necessarily the active player. */
  readonly player: PlayerId;
  /** Which racer's ability raised this, for UI attribution. */
  readonly source: RacerId;
  /** Short prompt, e.g. "Choose a racer to kick backward". */
  readonly prompt: string;
  readonly options: readonly DecisionOption[];
  /**
   * Which handler to re-enter on resume, and with what context. Opaque to clients —
   * stripped by redact().
   */
  readonly resume: Readonly<Record<string, unknown>>;
  /** Chosen automatically if the turn timer expires. Defaults to options[0]. */
  readonly defaultChoice: ChoiceId;
}

export interface DecisionOption {
  readonly id: ChoiceId;
  readonly label: string;
  /** Optional target for UI highlighting (a racer, a space). */
  readonly target?: { readonly t: 'racer'; readonly racerId: RacerId } | { readonly t: 'space'; readonly index: number };
}

export type Phase =
  /** Players joining; nobody has started yet. */
  | { readonly t: 'lobby' }
  /** Roll-off to determine draft order. Highest unique roll drafts first. */
  | { readonly t: 'draftRoll'; readonly rolls: Readonly<Record<PlayerId, number | null>> }
  /**
   * Snake draft. `pick` counts picks made so far across all four rounds, so the current
   * round is `floor(pick / playerCount)` and even rounds run forward, odd rounds reverse.
   *
   * Cards are dealt in waves of `2 * playerCount` face-up into `layout`; a wave covers two
   * rounds and is exhausted exactly as the next one is dealt.
   */
  | {
      readonly t: 'draft';
      readonly deck: readonly RacerId[];
      readonly layout: readonly RacerId[];
      readonly order: readonly PlayerId[];
      readonly pick: number;
    }
  /** Simultaneous secret selection of this race's racer. */
  | {
      readonly t: 'commit';
      readonly raceNo: RaceNumber;
      /** SECRET until every player has committed. Stripped per-player by redact(). */
      readonly committed: Readonly<Record<PlayerId, RacerId | null>>;
    }
  /** The race itself. */
  | {
      readonly t: 'racing';
      readonly raceNo: RaceNumber;
      readonly active: PlayerId;
      /** In finishing order. The race ends when this reaches FINISHERS_PER_RACE. */
      readonly finished: readonly PlayerId[];
      /**
       * Consecutive turns in which no racer gained ground. Feeds the stalemate rule:
       * blockers plus backward-movement abilities can genuinely deadlock a race.
       */
      readonly stalledTurns: number;
      /**
       * Star spaces already looted this race. Without this, a racer bounced back and
       * forth over a star space would farm it indefinitely.
       */
      readonly claimedSpaces: readonly number[];
    }
  /** Awards resolved; waiting for players to acknowledge before the next race. */
  | { readonly t: 'scored'; readonly raceNo: RaceNumber }
  | { readonly t: 'gameOver'; readonly winners: readonly PlayerId[] };

export interface GameState {
  /**
   * SERVER ONLY. Stripped by redact(). A client holding the seed could precompute
   * every future roll.
   */
  readonly seed: number;
  /** Monotonic action counter. Drives the RNG stream and reconnect deltas. */
  readonly step: number;

  readonly players: readonly Player[];
  /** Seat order, fixed at game start. Turn order within a race follows this. */
  readonly seatOrder: readonly PlayerId[];

  /** Drafted racers. Public — the draft happens in the open. */
  readonly hands: Readonly<Record<PlayerId, readonly RacerId[]>>;
  /** Racers already raced, and therefore no longer selectable. */
  readonly used: Readonly<Record<PlayerId, readonly RacerId[]>>;
  readonly scores: Readonly<Record<PlayerId, readonly Token[]>>;
  /** Remaining star supply, decremented across both Wild Wilds races. */
  readonly starSupply: Readonly<Record<1 | 3, number>>;

  readonly phase: Phase;
  /** Only populated during 'racing'. */
  readonly board: readonly RacerState[];
  readonly pending: PendingDecision | null;

  /**
   * Unix ms after which the active player (or pending decider) may be auto-advanced.
   * Null when no clock is running.
   */
  readonly deadline: number | null;
}

/**
 * What a client actually receives. Differs from GameState in exactly three ways:
 * the seed is gone, other players' secret commits are masked, and pending decisions
 * carry no resume context.
 */
export interface PlayerView extends Omit<GameState, 'seed' | 'phase' | 'pending'> {
  readonly you: PlayerId;
  readonly phase: RedactedPhase;
  readonly pending: RedactedPending | null;
}

export type RedactedPhase =
  | Exclude<Phase, { t: 'commit' }>
  | {
      readonly t: 'commit';
      readonly raceNo: RaceNumber;
      /** Your own choice, or null. */
      readonly yourCommit: RacerId | null;
      /** Who has locked in, without revealing what. */
      readonly committedBy: readonly PlayerId[];
    };

export type RedactedPending = Omit<PendingDecision, 'resume'>;
