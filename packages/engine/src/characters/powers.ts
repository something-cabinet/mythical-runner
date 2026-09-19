import { racerId, type RacerId } from '../ids.js';
import type { RacerState } from '../state.js';
import { FINISH } from '../tracks/index.js';
import { option, racerTarget, type Hooks } from './hooks.js';
import { getHooks } from './registry.js';

/**
 * Which power a racer actually has.
 *
 * Usually its own, but some racers take someone else's: Egg and Twin choose one before
 * the race and keep it, Copy Cat has whichever racer is leading at the moment, and
 * Morphling whichever is last. Every hook dispatch in the pipeline goes through
 * `hooksFor`, so the rest of the engine never has to know a power can be borrowed.
 */

export const COPY_CAT = racerId('copy-cat');
export const MORPHLING = racerId('morphling');

/**
 * Powers that are someone else's power, and where on the board that someone stands.
 * Copy Cat: "the racer currently in the lead". Morphling: "any racer currently last".
 */
const MIMICS: ReadonlyMap<RacerId, 'lead' | 'last'> = new Map([
  [COPY_CAT, 'lead'],
  [MORPHLING, 'last'],
]);

export function isMimic(power: RacerId): boolean {
  return MIMICS.has(power);
}

/** `memo` key holding a borrowed power's racer id. Set through `HookCtx.borrowPower`. */
export const BORROWED = 'borrowedPower';
/** `memo` key set by Silencer: how many of this racer's own turns it has no powers for. */
export const SILENCED = 'silenced';

/** Turns of silence `racer` has left. A bare `true`, from before silences had a length, is one. */
export function silencedTurns(racer: RacerState): number {
  const v = racer.memo[SILENCED];
  return v === true ? 1 : typeof v === 'number' ? v : 0;
}
/** `memo` key holding a permanent main move bonus, from Legion Commander's duel. */
export const MAIN_MOVE_BONUS = 'mainMoveBonus';
/** `memo` key set when a racer has given up its coming main move for a power. */
export const SKIP_MAIN = 'skipMainMove';
/** `memo` key holding a mimic's pick from a tie. */
const COPY_PICK = 'copyCatPick';
/** Resume key for a mimic's tie-break question. */
const COPY_PICK_KEY = 'copyCatPick';

const NO_HOOKS: Hooks = Object.freeze({});

interface BoardLike {
  readonly board: readonly RacerState[];
  /** Only needed to tell whose turn it is, for Silencer. */
  readonly phase?: { readonly t: string; readonly moving?: RacerId | null };
}

/** The racer whose card `racer` is using: its own, or a borrowed one. Copy Cat stays Copy Cat. */
export function powerOf(racer: RacerState): RacerId {
  const borrowed = racer.memo[BORROWED];
  return typeof borrowed === 'string' ? racerId(borrowed) : racer.racerId;
}

/**
 * The racers a mimic could be copying right now: everyone in the lead (or last) but itself.
 *
 * Read literally, a Copy Cat alone in the lead copies nobody, and so does a Morphling
 * alone in last. A racer that is itself mimicking offers nothing to copy, or two mimics
 * would chase each other's powers forever.
 */
function copyCandidates(s: BoardLike, self: RacerState, where: 'lead' | 'last'): RacerState[] {
  const field = s.board.filter((r) => !r.eliminated && r.finishedRank === null && r.pos !== FINISH);
  if (field.length === 0) return [];
  const positions = field.map((r) => r.pos);
  const target = where === 'lead' ? Math.max(...positions) : Math.min(...positions);
  return field.filter(
    (r) => r.pos === target && r.racerId !== self.racerId && !isMimic(powerOf(r)),
  );
}

/** Whose power a mimic has right now: its pick from a tie if still valid, else the first. */
export function copyTarget(s: BoardLike, self: RacerState): RacerId | null {
  const where = MIMICS.get(powerOf(self));
  if (!where) return null;
  const candidates = copyCandidates(s, self, where);
  const pick = self.memo[COPY_PICK];
  const chosen = candidates.find((r) => r.racerId === pick) ?? candidates[0];
  return chosen ? powerOf(chosen) : null;
}

/**
 * The hooks that fire for `racer`.
 *
 * `pinned` fixes a mimic's copied power, for resuming a question under the power that
 * asked it. `undefined` means work it out from the board.
 */
export function hooksFor(s: BoardLike, racer: RacerState, pinned?: RacerId | null): Hooks {
  // Silencer: "they can only roll for main move" — for the whole of each silenced turn.
  if (silencedTurns(racer) > 0 && s.phase?.t === 'racing' && s.phase.moving === racer.racerId) {
    return NO_HOOKS;
  }
  const power = powerOf(racer);
  const where = MIMICS.get(power);
  if (!where) return getHooks(power);
  return mimicHooks(where, pinned !== undefined ? pinned : copyTarget(s, racer));
}

const copyCache = new Map<string, Hooks>();

/**
 * COPY THAT — "I have the power of the racer currently in the lead. If there's a tie, I
 * pick." And Morphling: "I have the power of any racer currently last."
 *
 * The copied racer's hooks, minus "before race" ones ("I never copy 'before my race'
 * powers" — and at the start line every racer is last, so Morphling can't either), plus a
 * tie-break question at the start of the mimic's turn. The pick sticks while that racer
 * stays tied, so it can't switch mid-action; if they drop out, the mimic falls back to the
 * first candidate in board order until its next turn.
 */
function mimicHooks(where: 'lead' | 'last', target: RacerId | null): Hooks {
  const cacheKey = `${where}:${target ?? ''}`;
  const cached = copyCache.get(cacheKey);
  if (cached) return cached;

  const base: Hooks = target ? getHooks(target) : {};
  const { onRaceStart: _beforeRace, ...copied } = base;
  void _beforeRace;

  const hooks: Hooks = {
    ...copied,

    beforeMainMove: (h) => {
      const candidates = copyCandidates(h.state, h.self, where);
      if (candidates.length > 1) {
        h.ask({
          player: h.self.owner,
          prompt:
            where === 'lead'
              ? 'The lead is tied. Whose power do you copy?'
              : 'Last place is tied. Whose power do you take?',
          options: candidates.map((r) =>
            option(`copy:${r.racerId}`, h.nameOf(r), racerTarget(r.racerId)),
          ),
          key: COPY_PICK_KEY,
        });
        return;
      }
      base.beforeMainMove?.(h);
    },

    resume: (h, key, choice, data) => {
      if (key !== COPY_PICK_KEY) {
        base.resume?.(h, key, choice, data);
        return;
      }
      const picked = String(choice).slice('copy:'.length);
      h.self.memo[COPY_PICK] = picked;
      const model = h.racers().find((r) => r.racerId === racerId(picked));
      if (!model) return;
      h.log(
        where === 'lead'
          ? `${h.nameOf(h.self)} copies ${h.nameOf(model)}.`
          : `${h.nameOf(h.self)} morphs into ${h.nameOf(model)}.`,
      );
      // The tie is settled, so carry on with the chosen power's own "before my main move"
      // directly — going back through `beforeMainMove` would ask about the tie again.
      getHooks(powerOf(model)).beforeMainMove?.(h);
    },
  };

  copyCache.set(cacheKey, hooks);
  return hooks;
}
