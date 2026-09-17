import type { RaceContinue, RaceRoll } from '../actions.js';
import { racerName } from '../characters/registry.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { goldToken, silverToken, totalPoints } from '../scoring.js';
import { FINISH, START, type RaceNumber } from '../tracks/index.js';
import { FINISHERS_PER_RACE, RACE_COUNT } from '../state.js';
import { beginCommit } from './commit.js';
import { fireRaceStart, runQueue } from './pipeline.js';
import { activeRacers, type Ctx, racerOf, scoreOf, seatAt } from './working.js';

/**
 * How many consecutive turns without forward progress before a race is called off.
 *
 * Blockers and backward-movement abilities can genuinely deadlock a race, and finding
 * that out as an infinite loop in production is worse than capping it here. When it
 * trips, whoever already finished keeps their cups.
 */
const STALL_LIMIT_PER_PLAYER = 6;

export function beginRacing(ctx: Ctx, raceNo: RaceNumber, rng: Rng): void {
  const { s } = ctx;
  const first = firstSeatFor(ctx, raceNo, rng);

  s.phase = {
    t: 'racing',
    raceNo,
    active: first,
    finished: [],
    stalledTurns: 0,
    claimedSpaces: [],
    nextUp: null,
  };
  s.queue = [];
  s.turnStartPos = START;

  fireRaceStart(ctx, rng);
  announceTurn(ctx);
}

/**
 * Who leads off a race.
 *
 * Race 1: "Before the first race, roll off exactly like you did for the draft. Whoever
 * wins goes first."
 *
 * Races 2-4: "The player with the farthest behind (or first eliminated) racer in the last
 * race goes first in the next race." A catch-up rule, not a roll-off — `trailingPlayer` is
 * recorded when each race ends, while the board still exists.
 */
function firstSeatFor(ctx: Ctx, raceNo: RaceNumber, rng: Rng): PlayerId {
  const { s } = ctx;

  if (raceNo > 1 && s.trailingPlayer !== null && s.seatOrder.includes(s.trailingPlayer)) {
    ctx.emit({ t: 'turnOrder/set', raceNo, first: s.trailingPlayer, reason: 'trailing' });
    return s.trailingPlayer;
  }

  const first = rollOff(ctx, raceNo, rng);
  ctx.emit({ t: 'turnOrder/set', raceNo, first, reason: 'rolloff' });
  return first;
}

/** Everyone rolls; highest wins; ties re-roll among the tied players. */
function rollOff(ctx: Ctx, raceNo: RaceNumber, rng: Rng): PlayerId {
  const { s } = ctx;
  let contenders = [...s.seatOrder];
  const shown: { player: PlayerId; value: number }[] = [];

  // Terminates with probability 1; the bound only guards against an engine bug.
  for (let attempt = 0; attempt < 100 && contenders.length > 1; attempt++) {
    const rolls = contenders.map((player) => ({ player, value: rng.rollD6() }));
    if (attempt === 0) shown.push(...rolls);
    const best = Math.max(...rolls.map((r) => r.value));
    contenders = rolls.filter((r) => r.value === best).map((r) => r.player);
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
  s.turnStartPos = racer.pos;

  // Standing up from a trip is handled inside the mainMove job, because "your powers can
  // still trigger" on a tripped turn — only the roll and movement are skipped.
  s.queue.push(
    { t: 'beforeMove', racer: racer.racerId },
    { t: 'mainMove', racer: racer.racerId },
    { t: 'turnEnd', racer: racer.racerId, done: [] },
    { t: 'endTurn' },
  );

  runQueue(ctx, rng);
}

/**
 * Closes out a turn: record finishers, then hand on or end the race.
 *
 * Reached via the `endTurn` job rather than called directly, so it always runs after every
 * ability the turn triggered has fully resolved — including ones that suspended for
 * minutes waiting on a player.
 */
export function endTurn(ctx: Ctx): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'endTurn outside a race');
  // Captured once: emitting events invalidates TypeScript's narrowing of `s.phase`, and
  // re-asserting it on every line would bury the actual logic.
  const phase = s.phase;

  // Anyone who crossed the line this turn is placed now, in board order. Abilities can
  // push more than one racer over at once, so this is a sweep, not a single check.
  for (const racer of s.board) {
    if (racer.pos === FINISH && racer.finishedRank === null && !racer.eliminated) {
      const rank = phase.finished.length + 1;
      racer.finishedRank = rank;
      phase.finished.push(racer.owner);
      ctx.emit({ t: 'racer/finished', racerId: racer.racerId, player: racer.owner, rank });
    }
  }

  const mover = s.board.find((r) => r.owner === phase.active);
  const progressed = mover !== undefined && mover.pos > s.turnStartPos;
  phase.stalledTurns = progressed ? 0 : phase.stalledTurns + 1;

  if (phase.finished.length >= FINISHERS_PER_RACE) {
    endRace(ctx, false);
    return;
  }

  const remaining = activeRacers(s);
  if (remaining.length === 0) {
    endRace(ctx, false);
    return;
  }
  if (phase.stalledTurns >= s.seatOrder.length * STALL_LIMIT_PER_PLAYER) {
    endRace(ctx, true);
    return;
  }

  // Skipper: "I go next in turn order." A one-shot override, consumed here; turn order
  // then continues clockwise from Skipper as normal.
  const nextUp = phase.nextUp;
  phase.nextUp = null;
  if (nextUp && nextUp !== phase.active) {
    const racer = s.board.find((r) => r.owner === nextUp);
    if (racer && racer.finishedRank === null && !racer.eliminated) {
      phase.active = nextUp;
      announceTurn(ctx);
      return;
    }
  }

  // Advance to the next seat that still has a racer running.
  const n = s.seatOrder.length;
  const from = s.seatOrder.indexOf(phase.active);
  for (let i = 1; i <= n; i++) {
    const candidate = seatAt(s, (from + i) % n);
    const racer = s.board.find((r) => r.owner === candidate);
    if (racer && racer.finishedRank === null && !racer.eliminated) {
      phase.active = candidate;
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

  s.trailingPlayer = trailingPlayerOf(ctx);

  ctx.emit({ t: 'race/ended', raceNo, podium: [...podium], byStalemate });
  s.phase = { t: 'scored', raceNo };
  s.deadline = null;
  // Anything still queued belonged to a turn in a race that no longer exists.
  s.queue = [];
  s.pending = null;
}

/**
 * The player whose racer finished farthest behind, or was eliminated first.
 *
 * Eliminated racers outrank position entirely — the rulebook says "farthest behind (or
 * first eliminated)", and elimination order is recovered from `eliminationOrder`. Racers
 * that crossed the line are never candidates.
 */
function trailingPlayerOf(ctx: Ctx): PlayerId | null {
  const { s } = ctx;
  const eliminated = s.board
    .filter((r) => r.eliminated)
    .sort((a, b) => a.eliminationOrder - b.eliminationOrder);
  const firstOut = eliminated[0];
  if (firstOut) return firstOut.owner;

  const running = s.board.filter((r) => r.finishedRank === null);
  if (running.length === 0) return null;

  let worst = running[0];
  invariant(worst, 'unreachable: running is non-empty');
  for (const r of running) if (r.pos < worst.pos) worst = r;
  return worst.owner;
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
