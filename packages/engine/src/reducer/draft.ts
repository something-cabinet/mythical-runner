import type { DraftPick, DraftRoll } from '../actions.js';
import { ALL_RACER_IDS } from '../characters/registry.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId, RacerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { RACERS_PER_PLAYER } from '../state.js';
import { beginCommit } from './commit.js';
import { type Ctx, hand } from './working.js';

/**
 * Roll-off for draft order: highest goes first.
 *
 * "Highest unique" is the published wording, which is really a tie-break rule — anyone
 * sharing a value re-rolls, and only players holding a value nobody else rolled are
 * locked in. Repeating until all values are distinct terminates with probability 1.
 */
export function draftRoll(ctx: Ctx, a: DraftRoll, rng: Rng): void {
  const { s } = ctx;
  if (s.phase.t !== 'draftRoll') throw new IllegalActionError(a, 'not in the roll-off');
  if (!(a.by in s.phase.rolls)) throw new IllegalActionError(a, 'not in this room');
  if (s.phase.rolls[a.by] !== null) throw new IllegalActionError(a, 'already rolled');

  const value = rng.rollD6();
  s.phase.rolls[a.by] = value;
  ctx.emit({ t: 'draft/rolled', player: a.by, value });

  const entries = Object.entries(s.phase.rolls) as [PlayerId, number | null][];
  if (entries.some(([, v]) => v === null)) return; // still waiting on someone

  // Clear any tied values so those players roll again.
  const tally = new Map<number, number>();
  for (const [, v] of entries) if (v !== null) tally.set(v, (tally.get(v) ?? 0) + 1);

  let tied = false;
  for (const [p, v] of entries) {
    if (v !== null && (tally.get(v) ?? 0) > 1) {
      s.phase.rolls[p] = null;
      tied = true;
    }
  }
  if (tied) return;

  const order = entries
    .map(([p, v]) => ({ p, v: v as number }))
    .sort((x, y) => y.v - x.v)
    .map(({ p }) => p);

  ctx.emit({ t: 'draft/orderSet', order: [...order] });
  beginDraft(ctx, order, rng);
}

function beginDraft(ctx: Ctx, order: PlayerId[], rng: Rng): void {
  const { s } = ctx;
  const deck = rng.shuffle(ALL_RACER_IDS) as RacerId[];
  s.phase = { t: 'draft', deck, layout: [], order, pick: 0 };
  dealWaveIfNeeded(ctx);
}

/**
 * Deals a fresh face-up layout when the previous one runs out.
 *
 * A wave is `2 x playerCount` cards and covers exactly two rounds of the snake: everyone
 * picks once going forward, then once coming back, which consumes the layout precisely.
 */
function dealWaveIfNeeded(ctx: Ctx): void {
  const { s } = ctx;
  invariant(s.phase.t === 'draft', 'dealWave outside draft');
  const n = s.phase.order.length;
  if (s.phase.pick % (2 * n) !== 0) return;

  const wave = s.phase.deck.splice(0, 2 * n);
  invariant(wave.length === 2 * n, 'racer deck exhausted mid-draft');
  s.phase.layout = wave;
}

/** Whose pick it is, given the snake ordering. */
export function currentDrafter(order: readonly PlayerId[], pick: number): PlayerId {
  const n = order.length;
  const round = Math.floor(pick / n);
  const i = pick % n;
  const seat = round % 2 === 0 ? i : n - 1 - i;
  const p = order[seat];
  invariant(p, `no drafter at seat ${seat}`);
  return p;
}

export function draftPick(ctx: Ctx, a: DraftPick): void {
  const { s } = ctx;
  if (s.phase.t !== 'draft') throw new IllegalActionError(a, 'not drafting');

  const expected = currentDrafter(s.phase.order, s.phase.pick);
  if (expected !== a.by) throw new IllegalActionError(a, 'not your pick');

  const i = s.phase.layout.indexOf(a.racerId);
  if (i < 0) throw new IllegalActionError(a, 'that racer is not in the layout');

  s.phase.layout.splice(i, 1);
  hand(s, a.by).push(a.racerId);
  ctx.emit({ t: 'draft/picked', player: a.by, racerId: a.racerId });

  s.phase.pick += 1;

  const total = s.phase.order.length * RACERS_PER_PLAYER;
  if (s.phase.pick >= total) {
    beginCommit(ctx, 1);
    return;
  }
  dealWaveIfNeeded(ctx);
}
