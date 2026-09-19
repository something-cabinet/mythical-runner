import type { GameEvent } from '../events.js';
import type { ChoiceId, PlayerId, RacerId } from '../ids.js';
import type { Job, MoveReason } from '../jobs.js';
import type { Rng } from '../rng.js';
import type { DecisionOption, RacerState } from '../state.js';
import type { DeepMutable, MutableState } from '../reducer/working.js';

export type MutableRacer = DeepMutable<RacerState>;

/** Several dice thrown and combined into one face, e.g. Ogre Magi's d3 × d3. */
export interface CombinedThrow {
  /** The face that counts. */
  readonly face: number;
  /** Sides of each die thrown. */
  readonly sides: number;
  /** Each die's face, in the order thrown. */
  readonly dice: readonly number[];
}

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
  /**
   * Adds a line to the game log, attributed to `self` — and announces that `self`'s power
   * just happened, which Scoocher reacts to. So log once per happening: two lines for one
   * power would scooch twice.
   */
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

  /**
   * Trips a racer. False when nothing happened: they were already down, or shrugged it off
   * (Templar Assassin), so a power counting its trips counts only real ones.
   */
  trip(target: MutableRacer): boolean;

  /**
   * "I can skip my main move and…" — `self` gives up this turn's main move. Called before
   * the roll, from `beforeMainMove` or its `resume`.
   */
  skipMainMove(): void;
  eliminate(target: MutableRacer): void;
  award(player: PlayerId, value: number): void;
  /**
   * Takes back up to `value` points from a player's point chips. Cups are never touched.
   * Returns how many points were actually taken, which is less when the chips run out.
   */
  forfeit(player: PlayerId, value: number): number;

  /**
   * Rolls `target`'s own die — a d6, or whatever `dieSides` or `throwDie` says. For powers that make a
   * racer roll ("they roll a die", "we roll our dice"), so Chaos Knight throws its d20 there
   * too. The throw is announced, so the board tumbles the die like a main move's.
   *
   * Call it from the `resume` of an `askRoll`, so the player whose die it is throws it.
   */
  rollDie(target: MutableRacer): number;

  /**
   * Stops the game until `roller`'s player presses Roll, then calls this power's `resume`
   * with `key` and `data` — where it calls `rollDie(roller)`. The pause is the point: an
   * ability's roll is a moment everyone watches, and the player it matters to throws it.
   * Same rules as `ask`, since it is one.
   */
  askRoll(roller: MutableRacer, request: { readonly prompt: string; readonly key: string; readonly data?: unknown }): void;

  /**
   * Techies: lays a mine on space `pos`, which trips the next racer to stop there and is
   * then gone. Start and the finish can't be mined. False when nothing changed — already
   * mined, or a TRIP space.
   */
  mineSpace(pos: number): boolean;

  /**
   * Calls this power's `resume` with `key` and `data` once the work now running has
   * finished, where it may `ask`. For reacting with a question from a hook that must not
   * ask, like Abaddon offering help from `onRacerTripped`. `choice` arrives empty.
   */
  defer(key: string, data?: unknown): void;

  /**
   * Silencer: `target` has no powers at all during its next `turns` turns (default 1) —
   * "they can only roll for main move". Counted in the target's own turns; a longer silence
   * already on them stands.
   */
  silence(target: MutableRacer, turns?: number): void;

  /**
   * Legion Commander's duel prize: `target` gets `amount` more on every main move for the
   * rest of the race. Held by the engine rather than the granting power, so the bonus
   * outlives it — a racer that wins a duel keeps the prize even if the Commander is
   * eliminated, silenced or borrowed away.
   */
  addMainMoveBonus(target: MutableRacer, amount: number): void;

  /**
   * Skipper: "I go next in turn order." `self` takes the next turn once the current
   * player's team has gone, then turn order continues clockwise from `self`. Several
   * calls in one turn queue up in the order they were made.
   */
  cutInLine(): void;

  /**
   * Genius: "I take another turn after this one." `self` goes again straight
   * after the turn now resolving — before any teammate still to move, who follows it.
   */
  extraTurn(): void;

  /**
   * Mastermind: puts `self` into the next finishing place right now, whether or not it has
   * crossed the line — and even if it already holds a place, for "if I predict myself, I
   * can win both 1st and 2nd".
   */
  takePlace(): void;

  // --- The main move roll ----------------------------------------------------
  //
  // These act on the roll currently being decided, and are no-ops outside that window —
  // which is `onMainRoll`, `onMainRollFinal`, and any `resume` for a question asked there.

  /** The roll being decided, or null when no roll is in progress. */
  mainRoll(): MainRollView | null;
  /** Rolls the die again. The old number never happened, so every roll power re-fires. */
  rerollMainMove(): void;
  /** Replaces how far the main move goes. Still the main move, so still modified. */
  setMainMove(distance: number): void;
  /** The main move does not happen at all, and nothing may modify it back into one. */
  cancelMainMove(): void;
  /** Marks the roll, for once-per-turn powers. Cleared by nothing: one roll, one turn. */
  tagMainRoll(tag: string): void;

  // --- Borrowed powers -------------------------------------------------------

  /** Egg and Twin: from now until the race ends, `self` has `power`'s powers. */
  borrowPower(power: RacerId): void;
  /** Racers in no player's hand — the rest of the deck, for Egg's draw. */
  undrafted(): RacerId[];
  /** Racers that won an earlier race this game, oldest first — Twin's choices. */
  previousWinners(): RacerId[];

  /**
   * Suspends this power and asks `player` to choose.
   *
   * The engine stops draining the queue and resumes by calling this character's `resume`
   * with the same `key` and `data` once the answer arrives. `player` need not be the active
   * player — Duelist can be declared on someone else's turn.
   */
  ask(request: AskRequest): void;
}

export interface MainRollView {
  readonly mover: RacerId;
  /** The die face as it stands now, after any rerolls. */
  readonly value: number;
  readonly rerolls: number;
  readonly tags: readonly string[];
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
   * Chaos Knight, Storm Spirit: how many faces `self`'s die has. A d6 when absent. Applies to every roll
   * of that racer's die — the main move, rerolls, and `HookCtx.rollDie`.
   */
  dieSides?(h: HookCtx): number;

  /**
   * Ogre Magi: throws `self`'s die some other way than one die of `dieSides` faces. Returns
   * the face that counts, plus the dice behind it so the board can show them. Wins over
   * `dieSides`, and applies everywhere it does.
   */
  throwDie?(h: HookCtx): CombinedThrow;

  /**
   * Replaces the main move entirely, e.g. Legs' "skip rolling and move 5 instead".
   *
   * Return the distance to move instead of rolling, or null to roll normally. The result
   * still counts as the main move, so it is still subject to `modifyMainMove`.
   */
  replaceMainMove?(h: HookCtx): number | null;

  /**
   * Adjusts the main move distance: Gunk's −1, Coach's +1, Hare's +2. `mover` is whose
   * main move this is — always `self` when a racer modifies its own roll, but a different
   * racer when reacting to someone else's, which is how Coach tells whether the roller is
   * sharing his space.
   */
  modifyMainMove?(h: HookCtx, value: number, mover: MutableRacer): number;

  /**
   * Hare: "When I start my turn alone in the lead, I skip my main move." Checked before the
   * roll, alongside the trip check — no roll happens at all, same as a trip, except the
   * racer isn't laid down.
   */
  skipsMainMove?(h: HookCtx): boolean;

  /**
   * A die has just been rolled for a main move, and may yet be rerolled. Fires for the
   * mover, then everyone else in board order — and again from the top after every reroll.
   * Magician and Dicemonger offer rerolls here. Only for real rolls, never for a replaced
   * main move.
   */
  onMainRoll?(h: HookCtx, mover: MutableRacer, value: number): void;

  /**
   * The die for a main move is final: every reroll is spent. Powers that act on the number
   * itself fire here — Alchemist, Rocket Scientist, Sisyphus, and Genius checking its
   * prediction. Same order as `onMainRoll`; a reroll from here starts over at `onMainRoll`.
   */
  onMainRollFinal?(h: HookCtx, mover: MutableRacer, value: number): void;

  /**
   * Fires for every racer once a main move's die is final, before `modifyMainMove` runs.
   * Lackey, Inchworm and Skipper react to a specific number here. Returning 0 cancels the
   * main move (Inchworm's "they skip that move"); any other number overrides it. `mover`
   * may be `self`, for powers like Skipper's that don't care whose roll it was.
   *
   * May queue movement but must not `ask`: the roll is already committed at this point.
   */
  onAnyMainMoveRolled?(h: HookCtx, mover: MutableRacer, rolled: number): number | void;

  /**
   * "After my main move" — fires once the main move and everything it set off have
   * resolved. `from` is where `self` stood before the main move. Only for a main move that
   * actually went somewhere: a cancelled or zero-length one never happened.
   */
  afterMainMove?(h: HookCtx, from: number): void;

  /**
   * Templar Assassin: `self` is about to be tripped. Return true to shrug it off, in which
   * case the trip never happened — nothing reacts to it.
   */
  ignoresTrip?(h: HookCtx): boolean;

  /**
   * A racer was just tripped. Fires for every racer still in, the tripped one first, so
   * `target` may be `self` (Tidehunter getting up) or anyone (Oracle's prediction). Must
   * not `ask`: trips happen inside hooks that can't suspend.
   */
  onRacerTripped?(h: HookCtx, target: MutableRacer): void;

  /**
   * Dota's Alchemist: adjusts a cup or star-space chip `self` has just earned, before it is
   * handed over. Other point chips — a power's award — are not affected.
   */
  modifyAward?(h: HookCtx, value: number, source: 'cup' | 'star'): number;

  /** `self` stopped on a space, after any space effect resolved. */
  onStop?(h: HookCtx): void;

  /** Another racer stopped on a space. Fires for every racer, not just nearby ones. */
  onOtherStops?(h: HookCtx, other: MutableRacer): void;

  /**
   * Leaptoad: "While moving, I skip spaces with other racers on them." Checked per step;
   * an occupied space is passed over without being counted against the move.
   */
  skipsOccupiedSpaces?(h: HookCtx): boolean;

  /**
   * Suckerfish: fires when another racer sharing `self`'s space begins a move, before any
   * of its steps happen.
   */
  onOtherMoveStart?(h: HookCtx, mover: MutableRacer, distance: number, dir: 1 | -1): void;

  /** `self` passed `passed` during a move. */
  onPass?(h: HookCtx, passed: MutableRacer): void;

  /** `self` was passed by `passer` during their move. */
  onPassed?(h: HookCtx, passer: MutableRacer): void;

  /**
   * Huge Baby: "No one can ever be on my space." Return true to displace `mover` to the
   * space behind `self` instead of letting them stop here.
   */
  blocksSpace?(h: HookCtx, mover: MutableRacer): boolean;

  /**
   * Stickler: "Other racers can only cross the finish line by moving the exact number of
   * spaces they need." Checked against every other racer's move; true voids the whole move
   * rather than clamping it at the finish line.
   */
  blocksOvershoot?(h: HookCtx): boolean;

  /** End of `self`'s own turn. */
  onTurnEnd?(h: HookCtx): void;

  /**
   * Heckler: fires when another racer's turn ends. `startPos` is where they stood when
   * that turn began, so `Math.abs(other.pos - startPos) <= 1` is the rulebook's "within 1
   * space of where they started" — recovering from a trip included, since a tripped turn
   * still runs the whole pipeline down to this point.
   */
  onOtherTurnEnd?(h: HookCtx, other: MutableRacer, startPos: number): void;

  /**
   * Scoocher: another racer's power just happened. `text` is its log line. A power
   * "happens" when it logs through `HookCtx.log` or the pipeline acts on its behalf
   * (Huge Baby's displacement, Stickler's block, Leaptoad's jump), so one log line should
   * mean one happening.
   */
  onOtherPower?(h: HookCtx, source: MutableRacer, text: string): void;

  /**
   * A racer has just been placed. Fires for every racer still in the race, plus the
   * finisher itself. Must not `ask`: placements are settled at the end of a turn.
   */
  onRacerFinished?(h: HookCtx, finisher: MutableRacer, rank: number): void;

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
