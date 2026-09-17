import type { RaceCommit } from '../actions.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId, RacerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { trackForRace, START, type RaceNumber } from '../tracks/index.js';
import { racersPerRace } from '../state.js';
import { beginRacing } from './racing.js';
import { type Ctx, hand, used } from './working.js';

/** Opens the simultaneous secret selection for a race. */
export function beginCommit(ctx: Ctx, raceNo: RaceNumber): void {
  const { s } = ctx;
  s.phase = {
    t: 'commit',
    raceNo,
    committed: Object.fromEntries(s.seatOrder.map((p) => [p, []])),
  };
  s.board = [];
  s.deadline = null;
}

/** How many racers each player enters in a race here. */
export function commitSize(s: { seatOrder: readonly PlayerId[] }): number {
  return racersPerRace(s.seatOrder.length);
}

/**
 * Locks in one of a player's racers for this race.
 *
 * This is the game's only hidden information. The choice is held server-side and masked
 * by `redact` until the last player commits, at which point everything is revealed at
 * once — seeing an opponent's pick early would gut the decision.
 *
 * The two-player variant needs "2 different racers" each, so this takes one racer at a
 * time and the reveal waits until everyone's slate is full.
 */
export function raceCommit(ctx: Ctx, a: RaceCommit, rng: Rng): void {
  const { s } = ctx;
  if (s.phase.t !== 'commit') throw new IllegalActionError(a, 'not in the commit phase');
  const mine = s.phase.committed[a.by];
  if (!mine) throw new IllegalActionError(a, 'not in this room');
  const need = commitSize(s);
  if (mine.length >= need) throw new IllegalActionError(a, 'already committed');

  if (!hand(s, a.by).includes(a.racerId)) {
    throw new IllegalActionError(a, 'you did not draft that racer');
  }
  if (used(s, a.by).includes(a.racerId)) {
    throw new IllegalActionError(a, 'that racer has already raced');
  }
  if (mine.includes(a.racerId)) {
    throw new IllegalActionError(a, 'that racer is already entered in this race');
  }

  mine.push(a.racerId);

  // No event here on purpose: emitting which racer was chosen would leak it through the
  // event log even though the state is redacted. The UI infers "committed" from state.
  const entries = Object.entries(s.phase.committed) as [PlayerId, RacerId[]][];
  if (entries.some(([, r]) => r.length < need)) return;

  reveal(ctx, rng);
}

function reveal(ctx: Ctx, rng: Rng): void {
  const { s } = ctx;
  invariant(s.phase.t === 'commit', 'reveal outside commit');
  const raceNo = s.phase.raceNo as RaceNumber;

  // Seat by seat, each player's racers in the order they locked them in. Board order is
  // turn order within a player's own turn, and this is the only order anyone has stated.
  const picks = s.seatOrder.flatMap((p) => {
    const mine = s.phase.t === 'commit' ? (s.phase.committed[p] ?? []) : [];
    invariant(mine.length > 0, `player ${p} revealed without a commit`);
    return mine.map((racerId) => ({ player: p, racerId }));
  });

  ctx.emit({ t: 'race/revealed', picks: picks.map((x) => ({ ...x })) });

  for (const { player, racerId } of picks) used(s, player).push(racerId);

  s.board = picks.map(({ player, racerId }) => ({
    owner: player,
    racerId,
    pos: START,
    tripped: false,
    eliminated: false,
    eliminationOrder: 0,
    finishedRank: null,
    memo: {},
  }));

  ctx.emit({ t: 'race/started', raceNo, trackId: trackForRace(raceNo).id });
  beginRacing(ctx, raceNo, rng);
}
