import type { DraftPick } from '../actions.js';
import { racersInSets } from '../characters/registry.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId, RacerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { racersPerPlayer, racersPerRace } from '../state.js';
import { beginCommit } from './commit.js';
import { type Ctx, hand } from './working.js';

/**
 * Roll-off for draft order, settled all at once: highest goes first.
 *
 * "Highest unique" is the published wording, which is really a tie-break rule — anyone
 * sharing a value re-rolls, and only players holding a value nobody else rolled are
 * locked in. Nobody has a choice to make, so every round is thrown here rather than
 * waiting on each player to press a button. With at most six players a distinct set of
 * values always exists, so this terminates with probability 1.
 */
export function draftRollOff(ctx: Ctx, rng: Rng): void {
  const { s } = ctx;
  const rolls: Record<PlayerId, number> = {};
  let rolling = [...s.seatOrder];

  // The bound only guards against an engine bug.
  for (let attempt = 0; attempt < 1000 && rolling.length > 0; attempt++) {
    for (const p of rolling) rolls[p] = rng.rollD6();
    const tally = new Map<number, number>();
    for (const p of s.seatOrder) tally.set(rolls[p]!, (tally.get(rolls[p]!) ?? 0) + 1);
    rolling = s.seatOrder.filter((p) => (tally.get(rolls[p]!) ?? 0) > 1);
  }
  invariant(rolling.length === 0, 'draft roll-off never settled');

  const order = [...s.seatOrder].sort((x, y) => rolls[y]! - rolls[x]!);
  ctx.emit({ t: 'draft/orderSet', order: [...order], rolls: { ...rolls } });
  beginDraft(ctx, order, rolls, rng);
}

function beginDraft(ctx: Ctx, order: PlayerId[], rolls: Record<PlayerId, number>, rng: Rng): void {
  const { s } = ctx;
  const deck = rng.shuffle(racersInSets(s.racerSets)) as RacerId[];
  s.phase = { t: 'draft', deck, layout: [], order, rolls, pick: 0 };
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
