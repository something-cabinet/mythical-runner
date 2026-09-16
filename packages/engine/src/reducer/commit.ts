import type { RaceCommit } from '../actions.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId, RacerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { trackForRace, START, type RaceNumber } from '../tracks/index.js';
import { beginRacing } from './racing.js';
import { type Ctx, hand, used } from './working.js';

/** Opens the simultaneous secret selection for a race. */
export function beginCommit(ctx: Ctx, raceNo: RaceNumber): void {
  const { s } = ctx;
  s.phase = {
    t: 'commit',
    raceNo,
    committed: Object.fromEntries(s.seatOrder.map((p) => [p, null])),
  };
  s.board = [];
  s.deadline = null;
}

/**
 * Locks in one player's racer for this race.
 *
 * This is the game's only hidden information. The choice is held server-side and masked
 * by `redact` until the last player commits, at which point everything is revealed at
 * once — seeing an opponent's pick early would gut the decision.
 */
export function raceCommit(ctx: Ctx, a: RaceCommit, rng: Rng): void {
  const { s } = ctx;
  if (s.phase.t !== 'commit') throw new IllegalActionError(a, 'not in the commit phase');
  if (!(a.by in s.phase.committed)) throw new IllegalActionError(a, 'not in this room');
  if (s.phase.committed[a.by] !== null) throw new IllegalActionError(a, 'already committed');

  if (!hand(s, a.by).includes(a.racerId)) {
    throw new IllegalActionError(a, 'you did not draft that racer');
  }
  if (used(s, a.by).includes(a.racerId)) {
    throw new IllegalActionError(a, 'that racer has already raced');
  }

  s.phase.committed[a.by] = a.racerId;

  // No event here on purpose: emitting which racer was chosen would leak it through the
  // event log even though the state is redacted. The UI infers "committed" from state.
  const entries = Object.entries(s.phase.committed) as [PlayerId, RacerId | null][];
  if (entries.some(([, r]) => r === null)) return;

  reveal(ctx, rng);
}

function reveal(ctx: Ctx, rng: Rng): void {
  const { s } = ctx;
  invariant(s.phase.t === 'commit', 'reveal outside commit');
  const raceNo = s.phase.raceNo as RaceNumber;

  const picks = s.seatOrder.map((p) => {
    const racerId = s.phase.t === 'commit' ? s.phase.committed[p] : null;
    invariant(racerId, `player ${p} revealed without a commit`);
    return { player: p, racerId };
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
