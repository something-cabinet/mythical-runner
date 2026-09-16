import type { GameEvent } from '../events.js';
import type { PlayerId, RacerId } from '../ids.js';
import { invariant } from '../errors.js';
import type { GameState, RacerState } from '../state.js';

/**
 * Strips `readonly` recursively.
 *
 * `GameState` is deeply readonly because callers must never mutate it. Inside a single
 * `applyAction` the reducer works on a private clone instead, where mutation is both safe
 * and far easier to read than nested spread expressions. The clone is re-frozen into a
 * `GameState` on the way out.
 *
 * The `Primitive` arm must come first. Branded ids are `string & { [brand]: ... }`, which
 * is structurally an object — without the early exit, the mapped type recurses into
 * `String.prototype` and the brand is destroyed, silently turning every `PlayerId` back
 * into an unrelated object type.
 */
type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type DeepMutable<T> = T extends Primitive
  ? T
  : T extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;

export type MutableState = DeepMutable<GameState>;

/**
 * The reducer's working context: a private mutable clone plus the event list being built.
 *
 * Events are appended in the order things happen. That ordering is load-bearing — the
 * client animates from it one step at a time.
 */
export interface Ctx {
  readonly s: MutableState;
  readonly events: GameEvent[];
  emit(event: GameEvent): void;
  /**
   * Runs the `endTurn` job: finish detection, turn hand-off, race end.
   *
   * Injected by the reducer entry point rather than imported, because the pipeline runs
   * turn jobs and `racing.ts` owns turn-order rules — importing either direction would
   * make the two modules circular.
   */
  onEndTurn: () => void;
}

export function makeCtx(state: GameState): Ctx {
  const s = structuredClone(state) as MutableState;
  const events: GameEvent[] = [];
  return {
    s,
    events,
    emit(event) {
      events.push(event);
    },
    onEndTurn() {
      invariant(false, 'onEndTurn was not wired up by the reducer entry point');
    },
  };
}

/** Freezes the working copy back into an immutable GameState with `step` advanced. */
export function finish(ctx: Ctx): GameState {
  ctx.s.step += 1;
  return ctx.s as GameState;
}

// --- Lookup helpers ---------------------------------------------------------
//
// `noUncheckedIndexedAccess` makes every record and array access possibly-undefined.
// That is the correct default, but the reducer knows these keys exist, so these helpers
// assert once rather than littering every call site with `!`.

export function hand(s: MutableState, p: PlayerId): RacerId[] {
  const h = s.hands[p];
  invariant(h, `no hand for player ${p}`);
  return h;
}

export function used(s: MutableState, p: PlayerId): RacerId[] {
  const u = s.used[p];
  invariant(u, `no used list for player ${p}`);
  return u;
}

export function scoreOf(s: MutableState, p: PlayerId): DeepMutable<GameState['scores'][PlayerId]> {
  const sc = s.scores[p];
  invariant(sc, `no score list for player ${p}`);
  return sc;
}

export function seatAt(s: MutableState, i: number): PlayerId {
  const p = s.seatOrder[i];
  invariant(p, `no seat at index ${i}`);
  return p;
}

export function racerOf(s: MutableState, p: PlayerId): DeepMutable<RacerState> {
  const r = s.board.find((x) => x.owner === p);
  invariant(r, `player ${p} has no racer on the board`);
  return r;
}

export function findRacer(s: MutableState, id: RacerId): DeepMutable<RacerState> | undefined {
  return s.board.find((x) => x.racerId === id);
}

/** Racers still able to take turns: on the board, not finished, not eliminated. */
export function activeRacers(s: MutableState): DeepMutable<RacerState>[] {
  return s.board.filter((r) => r.finishedRank === null && !r.eliminated);
}

export function isHost(s: MutableState, p: PlayerId): boolean {
  return s.seatOrder.length > 0 && s.seatOrder[0] === p;
}
