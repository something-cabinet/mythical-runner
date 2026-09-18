import type { RaceContinue, RaceRoll } from '../actions.js';
import { racerName } from '../characters/registry.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId, RacerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { goldToken, silverToken, totalPoints, type Token } from '../scoring.js';
import { FINISH, START, type RaceNumber } from '../tracks/index.js';
import { FINISHERS_PER_RACE, RACE_COUNT, racersPerRace } from '../state.js';
import { beginCommit } from './commit.js';
import { hooksFor } from '../characters/powers.js';
import { makeHookCtx, runQueue } from './pipeline.js';
import { activeRacers, findRacer, racersOf, type Ctx, scoreOf, seatAt } from './working.js';

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
    toMove: [],
    moving: null,
    opened: [],
    finished: [],
    stalledTurns: 0,
    claimedSpaces: [],
    nextUp: [],
    turn: 0,
  };
  s.queue = [{ t: 'raceStart', done: [] }];
  s.turnStartPos = START;

  // May suspend — Egg and Twin choose a power before the race. The turn is announced
  // regardless; nobody can roll until the question is answered.
  runQueue(ctx, rng);
  beginPlayerTurn(ctx, first);
}

/**
 * Who leads off a race.
 *
 * Race 1: "Before the first race, roll off exactly like you did for the draft. Whoever
 * wins goes first."
 *
 * Races 2-4: "The player with the farthest behind (or first eliminated) racer in the last
 * race goes first in the next race." A catch-up rule, not a roll-off — `trailingPlayer` is
 * recorded when each race ends, while the board still exists. The two-player variant swaps
 * that for "the player who received the lower number of points in the last race goes first.
 * If tied, roll off!", which is why a null `trailingPlayer` falls through to a roll-off.
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

/**
 * Hands the turn to a player and works out which of their racers it covers.
 *
 * "On each player's first turn, they pick one racer to use. Then in all subsequent turns,
 * you use each of your racers in the order you want" — so a player's opening turn moves
 * one racer of their choosing, and every turn after it moves the whole team, one at a
 * time. With a single racer per player the two rules coincide, which is why the ordinary
 * game needs no separate path.
 */
function beginPlayerTurn(ctx: Ctx, player: PlayerId, only?: RacerId): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'beginPlayerTurn outside a race');
  const running = racersOf(s, player).filter((r) => r.finishedRank === null && !r.eliminated);
  s.phase.active = player;
  s.phase.toMove = only ? [only] : running.map((r) => r.racerId);
  announceTurn(ctx);
}

/** Announces the racer-turn about to happen. `racerId` is absent while the player picks. */
function announceTurn(ctx: Ctx): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'announceTurn outside a race');
  s.phase.turn += 1;
  s.phase.moving = null;
  const only = s.phase.toMove.length === 1 ? s.phase.toMove[0] : undefined;
  ctx.emit({
    t: 'turn/began',
    player: s.phase.active,
    ...(only ? { racerId: only } : {}),
  });
}

export function raceRoll(ctx: Ctx, a: RaceRoll, rng: Rng): void {
  const { s } = ctx;
  if (s.phase.t !== 'racing') throw new IllegalActionError(a, 'no race in progress');
  if (s.pending) throw new IllegalActionError(a, 'a decision is pending');
  if (s.phase.active !== a.by) throw new IllegalActionError(a, 'not your turn');
  if (s.phase.moving !== null) throw new IllegalActionError(a, 'a racer is already moving');

  const pick = a.racerId ?? (s.phase.toMove.length === 1 ? s.phase.toMove[0] : undefined);
  if (!pick) throw new IllegalActionError(a, 'say which racer is going');
  if (!s.phase.toMove.includes(pick)) throw new IllegalActionError(a, 'that racer has already gone');

  takeTurn(ctx, rng, pick);
}

/**
 * Resolves one full turn for the active player.
 *
 * Shared by `race/roll` and by the turn-timer path, so an absent player's turn plays out
 * identically to one they took themselves.
 */
export function takeTurn(ctx: Ctx, rng: Rng, racerId?: RacerId): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'takeTurn outside a race');

  // The timer path names nobody, so it moves whichever racer is next in board order —
  // the same racer an absent player's client would have had pre-selected.
  const pick = racerId ?? s.phase.toMove[0];
  invariant(pick, 'a turn with no racer left to move');
  const racer = findRacer(s, pick);
  invariant(racer, `racer ${pick} is not on the board`);
  s.phase.moving = pick;
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
export function endTurn(ctx: Ctx, rng: Rng): void {
  const { s } = ctx;
  invariant(s.phase.t === 'racing', 'endTurn outside a race');
  // Captured once: emitting events invalidates TypeScript's narrowing of `s.phase`, and
  // re-asserting it on every line would bury the actual logic.
  const phase = s.phase;

  // Anyone who crossed the line this turn is placed now, in board order. Abilities can
  // push more than one racer over at once, so this is a sweep, not a single check.
  const prevFinishedCount = phase.finished.length;
  for (const racer of s.board) {
    // Mastermind can fill the podium from inside this loop.
    if (phase.finished.length >= FINISHERS_PER_RACE) break;
    if (racer.pos !== FINISH || racer.finishedRank !== null || racer.eliminated) continue;

    const rank = phase.finished.length + 1;
    racer.finishedRank = rank;
    phase.finished.push(racer.owner);
    ctx.emit({ t: 'racer/finished', racerId: racer.racerId, player: racer.owner, rank });

    for (const other of s.board) {
      if (other.eliminated || (other.finishedRank !== null && other !== racer)) continue;
      hooksFor(s, other).onRacerFinished?.(makeHookCtx(ctx, rng, other), racer, rank);
      invariant(!s.pending, `${other.racerId} asked a question from onRacerFinished`);
    }
  }

  const moved = phase.moving;
  const newFinisher = phase.finished.length > prevFinishedCount;
  phase.stalledTurns = newFinisher ? 0 : phase.stalledTurns + 1;

  // That racer has had its turn. A player's opening turn ends after one racer whatever
  // else they have waiting; later turns run through the rest of the team.
  const opening = !phase.opened.includes(phase.active);
  if (opening) phase.opened.push(phase.active);
  phase.toMove = opening
    ? []
    : phase.toMove.filter((id) => {
        if (id === moved) return false;
        const r = findRacer(s, id);
        return r !== undefined && r.finishedRank === null && !r.eliminated;
      });
  phase.moving = null;

  if (phase.finished.length >= FINISHERS_PER_RACE) {
    endRace(ctx, false);
    return;
  }

  const remaining = activeRacers(s);
  if (remaining.length === 0) {
    endRace(ctx, false);
    return;
  }
  if (phase.stalledTurns >= s.board.length * STALL_LIMIT_PER_PLAYER) {
    endRace(ctx, true);
    return;
  }

  // The rest of the active player's team goes before the turn passes on.
  if (phase.toMove.length > 0) {
    announceTurn(ctx);
    return;
  }

  // Skipper's "I go next in turn order" and Genius's extra turn. Consumed one per
  // hand-off; turn order then continues clockwise from whoever took the turn. The racer
  // that just went may be next again — that is exactly what Genius's extra turn is. The
  // out-of-order turn belongs to that racer alone, not to the rest of its owner's team.
  while (phase.nextUp.length > 0) {
    const nextUp = phase.nextUp.shift();
    const racer = nextUp ? findRacer(s, nextUp) : undefined;
    if (racer && racer.finishedRank === null && !racer.eliminated) {
      beginPlayerTurn(ctx, racer.owner, racer.racerId);
      return;
    }
  }

  // Advance to the next seat that still has a racer running.
  const n = s.seatOrder.length;
  const from = s.seatOrder.indexOf(phase.active);
  for (let i = 1; i <= n; i++) {
    const candidate = seatAt(s, (from + i) % n);
    const running = racersOf(s, candidate).some(
      (r) => r.finishedRank === null && !r.eliminated,
    );
    if (running) {
      beginPlayerTurn(ctx, candidate);
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

  s.trailingPlayer = nextLeaderOf(ctx, raceNo);

  ctx.emit({ t: 'race/ended', raceNo, podium: [...podium], byStalemate });
  s.phase = { t: 'scored', raceNo };
  s.deadline = null;
  // Anything still queued belonged to a turn in a race that no longer exists.
  s.queue = [];
  s.pending = null;
}

/**
 * Who leads off the next race, or null to roll for it.
 *
 * Two players run the variant's rule: "the player who received the lower number of points
 * in the last race goes first. If tied, roll off!" Everyone else uses the standard
 * farthest-behind rule below.
 */
function nextLeaderOf(ctx: Ctx, raceNo: RaceNumber): PlayerId | null {
  const { s } = ctx;
  if (racersPerRace(s.seatOrder.length) === 1) return trailingPlayerOf(ctx);

  const scored = (p: PlayerId): number =>
    (scoreOf(s, p) as Token[])
      .filter((t) => t.raceNo === raceNo)
      .reduce((sum, t) => sum + t.value, 0);
  const ranked = [...s.seatOrder].sort((a, b) => scored(a) - scored(b));
  const [low, next] = ranked;
  if (!low || !next) return low ?? null;
  return scored(low) === scored(next) ? null : low;
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
