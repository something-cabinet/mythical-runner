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
  /** "Before my main move" powers. */
  | { t: 'beforeMove'; racer: RacerId }
  /** Determine the main move: `replaceMainMove`, else d6, then `modifyMainMove`. */
  | { t: 'mainMove'; racer: RacerId }
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
}

/** Describes who a decision belongs to, for the server's turn timer. */
export interface DecisionRequest {
  readonly player: PlayerId;
  readonly source: RacerId;
}
