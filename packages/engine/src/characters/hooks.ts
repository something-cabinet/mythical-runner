import type { GameEvent } from '../events.js';
import type { ChoiceId, PlayerId, RacerId } from '../ids.js';
import type { Job, MoveReason } from '../jobs.js';
import type { Rng } from '../rng.js';
import type { DecisionOption, RacerState } from '../state.js';
import type { DeepMutable, MutableState } from '../reducer/working.js';

export type MutableRacer = DeepMutable<RacerState>;

/**
 * Everything a character's handler is allowed to do.
 *
 * Handlers never touch `GameState` directly. They call these helpers, which emit the right
 * events and queue the right jobs, so ordering stays deterministic and the event log
 * remains a complete replay.
 */
export interface HookCtx {
  /** The racer whose power is firing. */
  readonly self: MutableRacer;
  readonly rng: Rng;
  /** Escape hatch for reads. Handlers must not mutate through this. */
  readonly state: MutableState;

  /** Every racer in the race, including finished and eliminated ones. */
  racers(): MutableRacer[];
  /** Racers still running: not finished, not eliminated. */
  running(): MutableRacer[];
  /** Racers stopped on a given space. */
  at(pos: number): MutableRacer[];
  /** Racers sharing `self`'s space. Excludes `self`. */
  sharing(): MutableRacer[];
  /** True when nothing shares `self`'s space — the rulebook's "alone". */
  alone(): boolean;
  /** Racers closest to the finish, excluding those already across. */
  lead(): MutableRacer[];
  /** Racers closest to Start. */
  lastPlace(): MutableRacer[];

  /**
   * A racer's display name, for prompts and log lines.
   *
   * Always use this rather than interpolating `racerId` — ids are identifiers like
   * `vanilla-01` or `baba-yaga`, and prompts are read by players.
   */
  nameOf(racer: MutableRacer | RacerId): string;

  emit(event: GameEvent): void;
  /** Adds a line to the game log, attributed to `self`. */
  log(text: string): void;

  /** Queues work to run next, nested under whatever is currently running. */
  next(...jobs: Job[]): void;

  // --- Effects ---------------------------------------------------------------

  /**
   * Moves a racer. Negative is backwards.
   *
   * "Moving 0 doesn't count as moving", so a zero distance is ignored entirely rather than
   * emitting a no-op move that other powers could trigger off.
   */
  move(target: MutableRacer, distance: number, reason?: MoveReason): void;

  /**
   * Warps a racer: "put their token on the new space, but don't count it as moving for
   * triggering powers, passing racers, etc."
   */
  warp(target: MutableRacer, pos: number): void;

  trip(target: MutableRacer): void;
  eliminate(target: MutableRacer): void;
  award(player: PlayerId, value: number): void;

  /**
   * Suspends this power and asks `player` to choose.
   *
   * The engine stops draining the queue and resumes by calling this character's `resume`
   * with the same `key` and `data` once the answer arrives. `player` need not be the active
   * player — Duelist can be declared on someone else's turn.
   */
  ask(request: AskRequest): void;
}

export interface AskRequest {
  readonly player: PlayerId;
  readonly prompt: string;
  readonly options: readonly DecisionOption[];
  /** Which continuation in `resume` to re-enter. */
  readonly key: string;
  /** Context to hand back on resume. Must be structured-cloneable. */
  readonly data?: unknown;
  /** Chosen if the turn timer expires. Defaults to the first option. */
  readonly defaultChoice?: ChoiceId;
}

/**
 * The hook points.
 *
 * Named after the rulebook's own vocabulary, because getting these boundaries wrong is how
 * a power ends up subtly non-conformant. Three distinctions matter most:
 *
 *  - **Passing** is "starts a move behind a racer and ends the same move ahead of them" —
 *    evaluated once the whole move is complete, never space by space.
 *  - **Stopping on a space** means finishing a move onto it, or arriving by a warp. Racers
 *    that merely cross a space mid-move never stop on it.
 *  - **Sharing a space** requires both racers to be *stopped* there. Temporary overlap
 *    during a move does not count.
 */
export interface Hooks {
  /** "Before my race" — fires once as the race is set up. */
  onRaceStart?(h: HookCtx): void;

  /**
   * "Before my main move" — fires once per turn, before the die is rolled.
   * Rule 5: powers at a specific time only happen once per turn.
   */
  beforeMainMove?(h: HookCtx): void;

  /**
   * Replaces the main move entirely, e.g. Legs' "skip rolling and move 5 instead".
   *
   * Return the distance to move instead of rolling, or null to roll normally. The result
   * still counts as the main move, so it is still subject to `modifyMainMove`.
   */
  replaceMainMove?(h: HookCtx): number | null;

  /** Adjusts the main move distance: Gunk's −1, Coach's +1, Hare's +2. */
  modifyMainMove?(h: HookCtx, value: number): number;

  /** `self` stopped on a space, after any space effect resolved. */
  onStop?(h: HookCtx): void;

  /** Another racer stopped on a space. Fires for every racer, not just nearby ones. */
  onOtherStops?(h: HookCtx, other: MutableRacer): void;

  /** `self` passed `passed` during a move. */
  onPass?(h: HookCtx, passed: MutableRacer): void;

  /** `self` was passed by `passer` during their move. */
  onPassed?(h: HookCtx, passer: MutableRacer): void;

  /**
   * Huge Baby: "No one can ever be on my space." Return true to displace `mover` to the
   * space behind `self` instead of letting them stop here.
   */
  blocksSpace?(h: HookCtx, mover: MutableRacer): boolean;

  /** End of `self`'s own turn. */
  onTurnEnd?(h: HookCtx): void;

  /** Re-entry point after `ask`. Must handle every `key` the character uses. */
  resume?(h: HookCtx, key: string, choice: ChoiceId, data: unknown): void;
}

export type HookName = keyof Hooks;

export function option(
  id: string,
  label: string,
  target?: DecisionOption['target'],
): DecisionOption {
  return target ? { id: id as ChoiceId, label, target } : { id: id as ChoiceId, label };
}

export function racerTarget(racerId: RacerId): DecisionOption['target'] {
  return { t: 'racer', racerId };
}
