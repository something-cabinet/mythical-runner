import type { RaceContinue, RaceRoll } from '../actions.js';
import { racerName } from '../characters/registry.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { goldToken, silverToken, totalPoints } from '../scoring.js';
import { FINISH, type RaceNumber } from '../tracks/index.js';
import { FINISHERS_PER_RACE, RACE_COUNT } from '../state.js';
import { beginCommit } from './commit.js';
import { moveSteps } from './movement.js';
import { activeRacers, type Ctx, racerOf, scoreOf, seatAt } from './working.js';

/**
 * How many consecutive turns without forward progress before a race is called off.
 *
 * Unreachable in phase 1 — every roll advances someone. It exists because phase 2's
 * blockers and backward-movement abilities genuinely can deadlock a race, and discovering
 * that via an infinite loop in production is worse than discovering it here.
 */
const STALL_LIMIT_PER_PLAYER = 6;

export function beginRacing(ctx: Ctx, raceNo: RaceNumber, rng: Rng): void {
  const { s } = ctx;
  const first = rollForFirstSeat(ctx, raceNo, rng);

  s.phase = {
    t: 'racing',
    raceNo,
    active: first,
    finished: [],
    stalledTurns: 0,
    claimedSpaces: [],
  };
  announceTurn(ctx);
}

/**
 * Rolls off for who takes the first turn of this race. Highest roll wins; ties re-roll.
 *
 * Going first is a genuine edge, because a race ends the moment the SECOND racer crosses
 * the line — late seats often never get a final turn. Re-rolling every race makes that
 * edge land on someone different each time instead of compounding on one seat.
 *
 * Resolved by the engine rather than as a player action. Players clicking a die four more
 * times per game would change nothing about the outcome, and the roll is shown in the log
 * either way.
 */
function rollForFirstSeat(ctx: Ctx, raceNo: RaceNumber, rng: Rng): PlayerId {
  const { s } = ctx;
  let contenders = [...s.seatOrder];
  const shown: { player: PlayerId; value: number }[] = [];

  // Terminates with probability 1; the bound only guards against an engine bug.
  for (let attempt = 0; attempt < 100 && contenders.length > 1; attempt++) {
    const rolls = contenders.map((player) => ({ player, value: rng.rollD6() }));
    if (attempt === 0) shown.push(...rolls);

    const best = Math.max(...rolls.map((r) => r.value));
    const winners = rolls.filter((r) => r.value === best).map((r) => r.player);
    contenders = winners;
  }

  const first = contenders[0];
  invariant(first, 'roll-off produced no winner');
  ctx.emit({ t: 'turnOrder/rolled', raceNo, rolls: shown, first });
  return first;
}

function announceTurn(ctx: Ctx): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'announceTurn outside a race');
  const racer = racerOf(s, s.phase.active);
  ctx.emit({ t: 'turn/began', player: s.phase.active, racerId: racer.racerId });
}

export function raceRoll(ctx: Ctx, a: RaceRoll, rng: Rng): void {
  const { s } = ctx;
  if (s.phase.t !== 'racing') throw new IllegalActionError(a, 'no race in progress');
  if (s.pending) throw new IllegalActionError(a, 'a decision is pending');
  if (s.phase.active !== a.by) throw new IllegalActionError(a, 'not your turn');

  takeTurn(ctx, rng);
}

/**
 * Resolves one full turn for the active player.
 *
 * Shared by `race/roll` and by the turn-timer path, so an absent player's turn plays out
 * identically to one they took themselves.
 */
export function takeTurn(ctx: Ctx, rng: Rng): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'takeTurn outside a race');

  const racer = racerOf(s, s.phase.active);
  const posBefore = racer.pos;

  if (racer.tripped) {
    // A tripped racer spends the whole turn getting up.
    racer.tripped = false;
    ctx.emit({ t: 'racer/stoodUp', racerId: racer.racerId });
  } else {
    // PHASE 2 SEAM: onTurnStart / replaceRoll / modifyRoll hooks fire around here.
    const value = rng.rollD6();
    ctx.emit({ t: 'dice/rolled', player: s.phase.active, racerId: racer.racerId, value });
    moveSteps(ctx, racer, value, 'roll');
  }

  if (racer.pos === FINISH && racer.finishedRank === null) {
    const rank = s.phase.finished.length + 1;
    racer.finishedRank = rank;
    s.phase.finished.push(racer.owner);
    ctx.emit({ t: 'racer/finished', racerId: racer.racerId, player: racer.owner, rank });
  }

  s.phase.stalledTurns = racer.pos > posBefore ? 0 : s.phase.stalledTurns + 1;

  endTurn(ctx);
}

function endTurn(ctx: Ctx): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'endTurn outside a race');

  if (s.phase.finished.length >= FINISHERS_PER_RACE) {
    endRace(ctx, false);
    return;
  }

  const remaining = activeRacers(s);
  if (remaining.length === 0) {
    endRace(ctx, false);
    return;
  }
  if (s.phase.stalledTurns >= s.seatOrder.length * STALL_LIMIT_PER_PLAYER) {
    endRace(ctx, true);
    return;
  }

  // Advance to the next seat that still has a racer running.
  const n = s.seatOrder.length;
  const from = s.seatOrder.indexOf(s.phase.active);
  for (let i = 1; i <= n; i++) {
    const candidate = seatAt(s, (from + i) % n);
    const racer = s.board.find((r) => r.owner === candidate);
    if (racer && racer.finishedRank === null && !racer.eliminated) {
      s.phase.active = candidate;
      announceTurn(ctx);
      return;
    }
  }
  invariant(false, 'no eligible next player despite active racers remaining');
}

/**
 * Awards the cups and closes the race.
 *
 * Only the first two across the line score. Everyone else gets nothing, which is what
 * makes holding a strong racer for a high-value race a real decision.
 */
function endRace(ctx: Ctx, byStalemate: boolean): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'endRace outside a race');
  const raceNo = s.phase.raceNo as RaceNumber;
  const podium = [...s.phase.finished];

  const first = podium[0];
  if (first !== undefined) {
    const token = goldToken(raceNo);
    scoreOf(s, first).push(token);
    ctx.emit({ t: 'token/awarded', player: first, token });
  }
  const second = podium[1];
  if (second !== undefined) {
    const token = silverToken(raceNo);
    scoreOf(s, second).push(token);
    ctx.emit({ t: 'token/awarded', player: second, token });
  }

  ctx.emit({ t: 'race/ended', raceNo, podium: [...podium], byStalemate });
  s.phase = { t: 'scored', raceNo };
  s.deadline = null;
}

/** Acknowledges the scoreboard and starts the next race, or ends the game. */
export function raceContinue(ctx: Ctx, a: RaceContinue): void {
  const { s } = ctx;
  if (s.phase.t !== 'scored') throw new IllegalActionError(a, 'no scoreboard to dismiss');
  if (!s.seatOrder.includes(a.by)) throw new IllegalActionError(a, 'not in this room');

  advanceAfterScoring(ctx);
}

export function advanceAfterScoring(ctx: Ctx): void {
  const { s } = ctx;
  invariant(s.phase.t === 'scored', 'advanceAfterScoring outside scoring');
  const raceNo = s.phase.raceNo;

  if (raceNo >= RACE_COUNT) {
    endGame(ctx);
    return;
  }
  beginCommit(ctx, (raceNo + 1) as RaceNumber);
}

function endGame(ctx: Ctx): void {
  const { s } = ctx;
  const finalScores = Object.fromEntries(
    s.seatOrder.map((p) => [p, totalPoints(scoreOf(s, p))]),
  ) as Record<PlayerId, number>;

  const best = Math.max(...Object.values(finalScores));
  // Ties are shared. The physical game has no stated tiebreak, and inventing one
  // would silently change outcomes.
  const winners = s.seatOrder.filter((p) => finalScores[p] === best);

  ctx.emit({ t: 'game/ended', winners: [...winners], finalScores });
  s.phase = { t: 'gameOver', winners };
  s.board = [];
  s.deadline = null;
}

/** Exposed for the timeout path and for log rendering. */
export function describeRacer(id: string): string {
  return racerName(id as never);
}
