import { racerId, type RacerId } from '../ids.js';
import type { RacerState } from '../state.js';
import { FINISH } from '../tracks/index.js';
import { option, racerTarget, type Hooks } from './hooks.js';
import { getHooks } from './registry.js';

/**
 * Which power a racer actually has.
 *
 * Usually its own, but three racers take someone else's: Egg and Twin choose one before
 * the race and keep it, and Copy Cat has whichever racer is leading at the moment. Every
 * hook dispatch in the pipeline goes through `hooksFor`, so the rest of the engine never
 * has to know a power can be borrowed.
 */

export const COPY_CAT = racerId('copy-cat');

/** `memo` key holding a borrowed power's racer id. Set through `HookCtx.borrowPower`. */
export const BORROWED = 'borrowedPower';
/** `memo` key holding Copy Cat's pick from a tied lead. */
const COPY_PICK = 'copyCatPick';
/** Resume key for Copy Cat's tie-break question. */
const COPY_PICK_KEY = 'copyCatPick';

interface BoardLike {
  readonly board: readonly RacerState[];
}

/** The racer whose card `racer` is using: its own, or a borrowed one. Copy Cat stays Copy Cat. */
export function powerOf(racer: RacerState): RacerId {
  const borrowed = racer.memo[BORROWED];
  return typeof borrowed === 'string' ? racerId(borrowed) : racer.racerId;
}

/**
 * The racers a Copy Cat could be copying right now: everyone in the lead but itself.
 *
 * "I have the power of the racer currently in the lead." Read literally, a Copy Cat alone
 * in the lead copies nobody. A leader that is itself copying (an Egg that drew Copy Cat)
 * offers nothing to copy, or the two would chase each other's powers forever.
 */
function copyCandidates(s: BoardLike, self: RacerState): RacerState[] {
  const field = s.board.filter((r) => !r.eliminated && r.finishedRank === null && r.pos !== FINISH);
  if (field.length === 0) return [];
  const best = Math.max(...field.map((r) => r.pos));
  return field.filter(
    (r) => r.pos === best && r.racerId !== self.racerId && powerOf(r) !== COPY_CAT,
  );
}

/** Whose power a Copy Cat has right now: its pick from a tie if still valid, else the first. */
export function copyTarget(s: BoardLike, self: RacerState): RacerId | null {
  const candidates = copyCandidates(s, self);
  const pick = self.memo[COPY_PICK];
  const chosen = candidates.find((r) => r.racerId === pick) ?? candidates[0];
  return chosen ? powerOf(chosen) : null;
}

/**
 * The hooks that fire for `racer`.
 *
 * `pinned` fixes a Copy Cat's copied power, for resuming a question under the power that
 * asked it. `undefined` means work it out from the board.
 */
export function hooksFor(s: BoardLike, racer: RacerState, pinned?: RacerId | null): Hooks {
  const power = powerOf(racer);
  if (power !== COPY_CAT) return getHooks(power);
  return copyCatHooks(pinned !== undefined ? pinned : copyTarget(s, racer));
}

const copyCache = new Map<string, Hooks>();

/**
 * COPY THAT — "I have the power of the racer currently in the lead. If there's a tie, I
 * pick."
 *
 * The copied racer's hooks, minus "before race" ones ("I never copy 'before my race'
 * powers"), plus a tie-break question at the start of Copy Cat's turn. The pick sticks
 * while that racer stays in the tied lead, so it can't switch mid-action; if they drop
 * out, Copy Cat falls back to the first leader in board order until its next turn.
 */
function copyCatHooks(target: RacerId | null): Hooks {
  const cacheKey = target ?? '';
  const cached = copyCache.get(cacheKey);
  if (cached) return cached;

  const base: Hooks = target ? getHooks(target) : {};
  const { onRaceStart: _beforeRace, ...copied } = base;
  void _beforeRace;

  const hooks: Hooks = {
    ...copied,

    beforeMainMove: (h) => {
      const candidates = copyCandidates(h.state, h.self);
      if (candidates.length > 1) {
        h.ask({
          player: h.self.owner,
          prompt: 'The lead is tied. Whose power do you copy?',
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
      const leader = h.racers().find((r) => r.racerId === racerId(picked));
      if (!leader) return;
      h.log(`${h.nameOf(h.self)} copies ${h.nameOf(leader)}.`);
      // The tie is settled, so carry on with the chosen power's own "before my main move"
      // directly — going back through `beforeMainMove` would ask about the tie again.
      getHooks(powerOf(leader)).beforeMainMove?.(h);
    },
  };

  copyCache.set(cacheKey, hooks);
  return hooks;
}
