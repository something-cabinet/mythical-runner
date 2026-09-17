import type { ChoiceId, PlayerId, RacerId } from './ids.js';
import type { Job } from './jobs.js';
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
  /** A computer player: never connects, and the server makes its moves. */
  readonly bot?: boolean;
}

/** One racer's situation during a race. Only committed racers appear on the board. */
export interface RacerState {
  readonly owner: PlayerId;
  readonly racerId: RacerId;
  /** START (0) .. FINISH (30). See tracks/types.ts. */
  readonly pos: number;
  /** A tripped racer skips their next main move, but their powers still trigger. */
  readonly tripped: boolean;
  readonly eliminated: boolean;
  /**
   * Order of elimination within the race, 1-based; 0 while still in.
   *
   * Needed because the next race's first player is "the player with the farthest behind
   * (or first eliminated) racer", and elimination order cannot be recovered from position.
   */
  readonly eliminationOrder: number;
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
 * Powers frequently need input from a player who is NOT the active player — Duelist can
 * be declared on someone else's turn, and every "CAN" power is optional. When a handler
 * needs one, it returns a PendingDecision; the engine parks, and the only legal action in
 * the entire game becomes that player's response.
 */
export interface PendingDecision {
  /** Who must answer. Not necessarily the active player. */
  readonly player: PlayerId;
  /** Which racer's power raised this, for UI attribution. */
  readonly source: RacerId;
  /** Short prompt, e.g. "Shout DUEL?". */
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
       * Consecutive turns in which no racer gained ground. Implements additional rule 9:
       * "If racer powers create a loop where no one can finish, the race ends with no one
       * getting the remaining points."
       */
      readonly stalledTurns: number;
      /**
       * Star spaces already looted this race. Without this, a racer bounced back and
       * forth over a star space would farm it indefinitely.
       */
      readonly claimedSpaces: readonly number[];
      /**
       * Players who take the next turns out of order, first to last: Skipper's "I go next
       * in turn order" and Genius's "I take another turn after this one". Consumed one per
       * hand-off; once empty, turn order continues clockwise from whoever went last, which
       * is what "after I go, turn order continues to my left" asks for.
       */
      readonly nextUp: readonly PlayerId[];
      /**
       * Counts turns begun this race. A turn can span many actions while powers wait on
       * questions, so this — not `step` — is what "this turn" means to a power that has to
       * remember something for exactly one turn (Scoocher's loop guard).
       */
      readonly turn: number;
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

  /**
   * Who leads off the next race: "the player with the farthest behind (or first
   * eliminated) racer in the last race". Computed as each race ends, while the board still
   * exists, because the board is cleared before the next race is set up. Null before race 1.
   */
  readonly trailingPlayer: PlayerId | null;

  readonly phase: Phase;
  /** Only populated during 'racing'. */
  readonly board: readonly RacerState[];
  readonly pending: PendingDecision | null;
  /**
   * Work still to do in the current turn.
   *
   * A turn cannot live on the JS call stack, because an ability may suspend mid-movement
   * to ask a player something and the Durable Object may hibernate before they answer.
   * So the turn is an explicit queue of jobs held in serializable state: the engine drains
   * it, and suspending simply means stopping with jobs still in it.
   *
   * Empty except while a turn is resolving or suspended on a decision. Never sent to
   * clients: `redact` strips it.
   */
  readonly queue: readonly Job[];

  /**
   * Where the active racer stood when its turn began.
   *
   * Held in state rather than a local because the turn may suspend and resume across
   * separate actions, and the stalemate counter needs to compare against the start of the
   * whole turn, not the start of the resumed fragment.
   */
  readonly turnStartPos: number;

  /**
   * Unix ms after which the active player (or pending decider) may be auto-advanced.
   * Null when no clock is running.
   */
  readonly deadline: number | null;
}

/**
 * What a client actually receives. Differs from GameState in exactly these ways:
 *
 *  - `seed` is gone, or the client could precompute every future roll;
 *  - other players' secret commits are masked;
 *  - pending decisions carry no resume context;
 *  - `queue` and `turnStartPos` are gone — they are the engine's working memory for a turn
 *    in progress, carry nothing a player needs, and exposing them would couple the client
 *    to the job model.
 */
export interface PlayerView
  extends Omit<GameState, 'seed' | 'phase' | 'pending' | 'queue' | 'turnStartPos'> {
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
