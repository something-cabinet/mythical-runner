import type { ChoiceId, PlayerId, RacerId } from './ids.js';

/**
 * One unit of pending work inside a turn.
 *
 * Jobs exist because powers can suspend. A racer moving six spaces may be interrupted by a
 * Duelist demanding an answer from a player who is not even the active one; that answer
 * might not arrive for minutes, during which the Durable Object hibernates and the JS call
 * stack ceases to exist.
 *
 * So the turn is not a call stack — it is this queue, held in serializable state.
 */
export type Job =
  /**
   * "Before my race" powers, for every racer on the board. `done` holds `racer:power`
   * keys rather than racer ids, so a racer whose power changes mid-setup — Twin borrowing
   * Egg — still gets the new power's "before race" effect: "I still get any 'before race'
   * powers."
   */
  | { t: 'raceStart'; done: string[] }
  /** "Before my main move" powers. */
  | { t: 'beforeMove'; racer: RacerId }
  /** Determine the main move: `replaceMainMove`, else d6, then hand off to `roll`. */
  | { t: 'mainMove'; racer: RacerId }
  /**
   * A main move whose raw value is known but not yet final.
   *
   * The window where powers decide about a roll — rerolling it (Magician, Dicemonger),
   * transforming it (Alchemist, Rocket Scientist), or refusing it (Sisyphus). It is a job
   * rather than a local because those decisions suspend: the roll has to survive until
   * the answer arrives. Powers reach it through `HookCtx.mainRoll` and friends.
   *
   * Runs in two stages. `reroll` goes first so that nobody commits to a transformation
   * of a number that is about to be rerolled; a reroll sends it back to `reroll` with
   * `done` cleared, since "treat the previous number you rolled as if it never happened."
   */
  | {
      t: 'roll';
      racer: RacerId;
      /** The die face, or the replacement from `replaceMainMove`. */
      value: number;
      /** False for a replaced main move — nothing was rolled, so nothing can be rerolled. */
      die: boolean;
      stage: 'reroll' | 'final';
      /** Racers whose hook for the current stage has already fired. */
      done: RacerId[];
      /** A power's replacement distance for this main move, or null to use `value`. */
      distance: number | null;
      /** The main move will not happen at all — Sisyphus, or Inchworm's wriggle. */
      cancelled: boolean;
      rerolls: number;
      /** Once-per-roll markers, e.g. Dicemonger's "once per turn". */
      tags: string[];
      modifiedBy: RacerId | null;
    }
  /**
   * Step-by-step movement.
   *
   * `remaining` counts down, so the job is its own continuation. `origin` and `startAhead`
   * capture the state at the start of the move, because passing is judged across the whole
   * move rather than step by step.
   */
  | {
      t: 'move';
      racer: RacerId;
      remaining: number;
      dir: 1 | -1;
      reason: MoveReason;
      /** Where the move began, for the pass calculation. */
      origin: number;
      /** Racers this racer was behind when the move began. */
      startBehind: RacerId[];
      /**
       * Null until the first step runs, then the racers already told the move is starting
       * (Suckerfish). `origin` and `startBehind` are re-captured at that point, because a
       * move can sit in the queue while other moves resolve ahead of it.
       */
      started: RacerId[] | null;
      /** True if this move is the racer's main move, which some powers key off. */
      isMainMove: boolean;
      /** False for moves caused by a space effect, so arrows do not chain forever. */
      resolveStop: boolean;
    }
  /** Resolve passing, once a move has fully completed. */
  | {
      t: 'passCheck';
      racer: RacerId;
      startBehind: RacerId[];
      /** Racers already notified, so a suspension does not re-trigger them. */
      done: RacerId[];
    }
  /** Apply the effect of the space a racer stopped on. */
  | { t: 'spaceEffect'; racer: RacerId; pos: number }
  /** Fire `onStop` for the racer, and `onOtherStops` for everyone else. */
  | { t: 'stopHooks'; racer: RacerId; done: RacerId[]; pos: number }
  /** Fire `onTurnEnd` for the racer, and `onOtherTurnEnd` for everyone else. */
  | { t: 'turnEnd'; racer: RacerId; done: RacerId[] }
  /** Check finishers, then hand the turn on or end the race. */
  | { t: 'endTurn' }
  /** Re-enter a suspended power once its question has been answered. */
  | {
      t: 'resume';
      racer: RacerId;
      key: string;
      data: unknown;
      choice: ChoiceId;
      /** See `ResumeDescriptor.copy`. */
      copy?: RacerId | null;
    };

export type MoveReason = 'main' | 'power' | 'space';

export type JobType = Job['t'];

/**
 * What `pending.resume` carries: enough to rebuild the `resume` job once answered.
 *
 * Kept on the pending decision rather than pre-queued, so during a suspension the queue
 * holds only the interrupted work. The interrupted job re-queues itself normally and the
 * resume job is unshifted in front of it.
 */
export interface ResumeDescriptor {
  readonly racer: RacerId;
  readonly key: string;
  readonly data: unknown;
  /**
   * For a Copy Cat, whose power it had when it asked. The lead can change while a
   * question waits, but "I can't switch my power mid-action", so the answer goes back to
   * the power that asked. Absent for everyone else.
   */
  readonly copy?: RacerId | null;
}

/** Describes who a decision belongs to, for the server's turn timer. */
export interface DecisionRequest {
  readonly player: PlayerId;
  readonly source: RacerId;
}
