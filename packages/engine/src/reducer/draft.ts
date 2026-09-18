import type { DraftPick, DraftRoll } from '../actions.js';
import { racersInSets } from '../characters/registry.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId, RacerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { racersPerPlayer, racersPerRace } from '../state.js';
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
  const deck = rng.shuffle(racersInSets(s.racerSets)) as RacerId[];
  s.phase = { t: 'draft', deck, layout: [], order, pick: 0 };
  dealWaveIfNeeded(ctx);
}

/**
 * How many rounds of the snake one line of face-up cards covers.
 *
 * Two normally — forward once, back once — and four in the two-player variant, whose line
 * of 8 is drafted "ABBAABBA" before the next line is dealt.
 */
function roundsPerLine(playerCount: number): number {
  return 2 * racersPerRace(playerCount);
}

/**
 * Deals a fresh face-up line when the previous one runs out.
 *
 * A line is `playerCount x roundsPerLine` cards, so it is consumed exactly as the next one
 * is dealt.
 */
function dealWaveIfNeeded(ctx: Ctx): void {
  const { s } = ctx;
  invariant(s.phase.t === 'draft', 'dealWave outside draft');
  const n = s.phase.order.length;
  const size = n * roundsPerLine(n);
  if (s.phase.pick % size !== 0) return;

  const wave = s.phase.deck.splice(0, size);
  invariant(wave.length === size, 'racer deck exhausted mid-draft');
  s.phase.layout = wave;
}

/**
 * Whose pick it is, given the snake ordering.
 *
 * Rounds alternate direction, and each new line of cards shifts the whole snake one seat
 * along: "repeat this process, starting with the player to the left of the start player".
 * With two players that shift is the variant's "do it again with 8 more racers from the
 * deck, in reverse order" — ABBAABBA, then BAABBAAB.
 */
export function currentDrafter(order: readonly PlayerId[], pick: number): PlayerId {
  const n = order.length;
  const round = Math.floor(pick / n);
  const i = pick % n;
  const line = Math.floor(round / roundsPerLine(n));
  const seat = (line + (round % 2 === 0 ? i : n - 1 - i)) % n;
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

  const total = s.phase.order.length * racersPerPlayer(s.phase.order.length);
  if (s.phase.pick >= total) {
    beginCommit(ctx, 1);
    return;
  }
  dealWaveIfNeeded(ctx);
}
