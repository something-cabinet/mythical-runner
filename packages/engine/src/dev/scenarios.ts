/**
 * Per-racer scenario tests.
 *
 * Each test hand-builds a `GameState` with racers placed exactly where the power should
 * fire, applies one action, and asserts on the resulting events and positions. Building
 * state directly rather than playing a game up to that point is the whole reason the
 * engine is a pure function over plain data.
 *
 * Power text is quoted from `docs/magical-athlete-rules.md`, which is the authority.
 *
 *   npx tsc && node dist/dev/scenarios.js
 */

import { applyAction, initGame, legalActions } from '../reducer/index.js';
import { currentDrafter } from '../reducer/draft.js';
import { playGame } from './hotseat.js';
import type { Action } from '../actions.js';
import type { GameEvent } from '../events.js';
import { choiceId, playerId, racerId } from '../ids.js';
import { FINISH, START } from '../tracks/index.js';
import type { GameState, RacerState } from '../state.js';
import type { CharacterSetId } from '../characters/sets.js';
import { racerSet } from '../characters/registry.js';
import { pointsToken } from '../scoring.js';

// --- Harness ----------------------------------------------------------------

let failures = 0;
let checks = 0;

function check(cond: boolean, label: string, detail?: string): void {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

interface Placement {
  readonly player: string;
  readonly racer: string;
  readonly pos: number;
  readonly tripped?: boolean;
  readonly memo?: Record<string, unknown>;
}

/** Builds a mid-race state — on the Mild Mile, whose spaces are all inert, unless `raceNo` says otherwise. */
function raceState(placements: readonly Placement[], active: string, raceNo: 1 | 2 | 3 | 4 = 1): GameState {
  const base = initGame(4242);
  const players = [...new Set(placements.map((p) => p.player))].map(playerId);

  const board: RacerState[] = placements.map((p) => ({
    owner: playerId(p.player),
    racerId: racerId(p.racer),
    pos: p.pos,
    tripped: p.tripped ?? false,
    eliminated: false,
    eliminationOrder: 0,
    finishedRank: null,
    memo: p.memo ?? {},
  }));

  return {
    ...base,
    players: players.map((id, i) => ({ id, name: `P${i + 1}`, connected: true })),
    seatOrder: players,
    // Grouped, because a player can have more than one racer on the track in the
    // two-player variant.
    hands: Object.fromEntries(
      players.map((p) => [p, board.filter((r) => r.owner === p).map((r) => r.racerId)]),
    ),
    used: Object.fromEntries(
      players.map((p) => [p, board.filter((r) => r.owner === p).map((r) => r.racerId)]),
    ),
    scores: Object.fromEntries(players.map((p) => [p, []])),
    phase: {
      t: 'racing',
      raceNo,
      active: playerId(active),
      toMove: board.filter((r) => r.owner === playerId(active)).map((r) => r.racerId),
      moving: null,
      opened: [],
      finished: [],
      stalledTurns: 0,
      claimedSpaces: [],
      nextUp: [],
      turn: 0,
    },
    board,
    queue: [],
    turnStartPos: board.find((r) => r.owner === playerId(active))?.pos ?? START,
  };
}

const posOf = (s: GameState, racer: string): number =>
  s.board.find((r) => r.racerId === racerId(racer))?.pos ?? NaN;

const racerAt = (s: GameState, racer: string): RacerState | undefined =>
  s.board.find((r) => r.racerId === racerId(racer));

const has = (events: readonly GameEvent[], t: GameEvent['t']): boolean =>
  events.some((e) => e.t === t);

const logLines = (events: readonly GameEvent[]): string =>
  events
    .filter((e) => e.t === 'ability/triggered')
    .map((e) => (e as { text: string }).text)
    .join(' | ');

const roll = (by: string, racer?: string): Action => ({
  t: 'race/roll',
  by: playerId(by),
  ...(racer ? { racerId: racerId(racer) } : {}),
});
const decide = (by: string, choice: string): Action => ({
  t: 'race/decide',
  by: playerId(by),
  choice: choiceId(choice),
});

/**
 * Rolls, forcing a specific die result by searching seeds.
 *
 * Dice derive from `(seed, step)`, so the only way to script a roll is to find a seed that
 * produces it. That keeps the tests running the real engine rather than a mocked RNG.
 *
 * `answer` auto-resolves any decision raised along the way, for racers like Legs whose
 * "CAN" power suspends before the roll even happens.
 */
function rollFor(
  state: GameState,
  by: string,
  want: number,
  answer?: { by: string; choice: string },
): { state: GameState; events: GameEvent[] } {
  for (let seed = 1; seed < 40000; seed++) {
    let s: GameState = { ...state, seed };
    const events: GameEvent[] = [];

    const res = applyAction(s, roll(by));
    s = res.state;
    events.push(...res.events);

    if (s.pending && answer) {
      const r2 = applyAction(s, decide(answer.by, answer.choice));
      s = r2.state;
      events.push(...r2.events);
    }

    const rolled = events.find((e) => e.t === 'dice/rolled');
    if (rolled && (rolled as { value: number }).value === want) return { state: s, events };
  }
  throw new Error(`could not find a seed producing a roll of ${want}`);
}

/**
 * Rolls with seed after seed until `found` accepts the result.
 *
 * For powers that ask about the roll before the move happens, where `rollFor` can't help:
 * the question arrives before any `dice/rolled`, so the test has to look at the die still
 * waiting in the queue instead.
 */
function rollUntil(
  state: GameState,
  by: string,
  found: (res: { state: GameState; events: readonly GameEvent[] }) => boolean,
): { state: GameState; events: readonly GameEvent[] } {
  for (let seed = 1; seed < 40000; seed++) {
    const res = applyAction({ ...state, seed }, roll(by));
    if (found(res)) return res;
  }
  throw new Error('could not find a seed producing the wanted roll');
}

/** The die of the main move being decided, if one is waiting on a question. */
const pendingDie = (s: GameState): number | undefined => {
  const job = s.queue.find((j) => j.t === 'roll');
  return job?.t === 'roll' ? job.value : undefined;
};

const moverAt = (s: GameState): string =>
  s.phase.t === 'racing' ? String(s.phase.active) : `(${s.phase.t})`;

/** A commit-phase state for `raceNo`, so "before my race" powers can be tested for real. */
function commitState(
  hands: Record<string, readonly string[]>,
  raceNo: 1 | 2 | 3 | 4,
  extra: Partial<GameState> = {},
): GameState {
  const base = initGame(4242);
  const players = Object.keys(hands).map((p) => playerId(p));
  return {
    ...base,
    players: players.map((id, i) => ({ id, name: `P${i + 1}`, connected: true })),
    seatOrder: players,
    hands: Object.fromEntries(Object.entries(hands).map(([p, rs]) => [p, rs.map(racerId)])),
    used: Object.fromEntries(players.map((p) => [p, []])),
    scores: Object.fromEntries(players.map((p) => [p, []])),
    phase: { t: 'commit', raceNo, committed: Object.fromEntries(players.map((p) => [p, []])) },
    ...extra,
  };
}

const commit = (by: string, racer: string): Action => ({
  t: 'race/commit',
  by: playerId(by),
  racerId: racerId(racer),
});

const pointsOf = (s: GameState, player: string): number =>
  (s.scores[playerId(player)] ?? []).reduce((sum, t) => sum + t.value, 0);

function scenario(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  try {
    fn();
  } catch (err) {
    failures++;
    console.log(`  FAIL  threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Scenarios --------------------------------------------------------------

scenario('Legs — JOG is optional ("I CAN skip rolling...")', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'legs', pos: 3 },
      { player: 'p2', racer: 'vanilla-01', pos: 3 },
    ],
    'p1',
  );
  const first = applyAction(s, roll('p1'));

  check(first.state.pending !== null, 'asks before rolling');
  check(first.state.pending?.player === playerId('p1'), 'asks the owner');

  const jogged = applyAction(first.state, decide('p1', 'jog'));
  check(posOf(jogged.state, 'legs') === 8, 'jogging moves exactly 5', `pos ${posOf(jogged.state, 'legs')}`);

  const rolledInstead = applyAction(first.state, decide('p1', 'roll'));
  const d = rolledInstead.events.find((e) => e.t === 'dice/rolled') as { value: number };
  check(d.value >= 1 && d.value <= 6, 'declining rolls a normal die', `got ${d.value}`);
});

scenario('Banana — "I trip any racer that passes me"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'banana', pos: 3 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 5);

  check(has(events, 'racer/passed'), 'a pass was detected');
  check(racerAt(state, 'vanilla-01')?.tripped === true, 'the passer is tripped');
  check(
    posOf(state, 'vanilla-01') === 6,
    'tripping does NOT cut the move short — full 5 spaces moved',
    `pos ${posOf(state, 'vanilla-01')}`,
  );
  check(logLines(events).includes('slips on Banana'), 'log names the culprit');
});

scenario('Banana — landing on it is not passing', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'banana', pos: 3 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 2);

  check(posOf(state, 'vanilla-01') === 3, 'stopped on Banana');
  check(
    racerAt(state, 'vanilla-01')?.tripped !== true,
    'sharing a space is neither ahead nor behind, so no pass and no trip',
  );
});

scenario('Centaur — "When I pass a racer, they move -2" (mandatory)', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'centaur', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 3 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 5);

  check(state.pending === null, 'no question asked — the power is mandatory');
  check(posOf(state, 'centaur') === 6, 'Centaur completes its move');
  check(posOf(state, 'vanilla-01') === 1, 'the passed racer is knocked back 2', `pos ${posOf(state, 'vanilla-01')}`);
  check(logLines(events).includes('hoofwhacks'), 'hoofwhack logged');
});

scenario('Centaur — cannot hoofwhack past the Start space', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'centaur', pos: 0 },
      { player: 'p2', racer: 'vanilla-01', pos: 1 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 4);
  check(posOf(state, 'vanilla-01') === START, 'clamped at Start', `pos ${posOf(state, 'vanilla-01')}`);
});

scenario('Huge Baby — displaces rather than blocking', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'huge-baby', pos: 4 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 3);

  check(posOf(state, 'vanilla-01') === 3, 'put on the space behind Huge Baby', `pos ${posOf(state, 'vanilla-01')}`);
  check(logLines(events).includes("can't fit past"), 'displacement logged');
  const moves = events.filter((e) => e.t === 'racer/moved');
  check(moves.length === 3, 'the displacement itself emitted no move event', `${moves.length} moves`);
});

scenario('Huge Baby — racers may still pass straight over', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'huge-baby', pos: 3 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 5);
  check(posOf(state, 'vanilla-01') === 6, 'passed over without being stopped', `pos ${posOf(state, 'vanilla-01')}`);
});

scenario('M.O.U.T.H. — chomps when IT stops with exactly one other racer', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'mouth', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 4 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 3);

  check(has(events, 'racer/eliminated'), 'elimination emitted');
  check(racerAt(state, 'vanilla-01')?.eliminated === true, 'the shared-space racer is out');
  check(racerAt(state, 'vanilla-01')?.eliminationOrder === 1, 'elimination order recorded');
});

scenario('M.O.U.T.H. — a crowd is safe (needs EXACTLY one)', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'mouth', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 4 },
      { player: 'p3', racer: 'vanilla-02', pos: 4 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 3);
  check(!state.board.some((r) => r.eliminated), 'two racers on the space, nobody eaten');
});

scenario('M.O.U.T.H. — landing on M.O.U.T.H. does not trigger it', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'mouth', pos: 4 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 3);
  check(!state.board.some((r) => r.eliminated), 'the power is about where M.O.U.T.H. stops');
});

scenario('Baba Yaga — trips both ways', () => {
  const arriving = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'baba-yaga', pos: 4 },
    ],
    'p1',
  );
  const a = rollFor(arriving, 'p1', 3);
  check(racerAt(a.state, 'vanilla-01')?.tripped === true, 'racer stopping on Baba Yaga trips');

  const departing = raceState(
    [
      { player: 'p1', racer: 'baba-yaga', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 4 },
    ],
    'p1',
  );
  const b = rollFor(departing, 'p1', 3);
  check(racerAt(b.state, 'vanilla-01')?.tripped === true, 'Baba Yaga stopping on a racer trips them');
});

scenario('Trip — skips the next main move but still runs powers', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 4, tripped: true },
      { player: 'p2', racer: 'vanilla-02', pos: 9 },
    ],
    'p1',
  );
  const res = applyAction(s, roll('p1'));

  check(has(res.events, 'racer/stoodUp'), 'stood up instead of moving');
  check(!has(res.events, 'dice/rolled'), 'no die rolled');
  check(posOf(res.state, 'vanilla-01') === 4, 'did not move');
  check(racerAt(res.state, 'vanilla-01')?.tripped === false, 'recovered for next turn');
});

scenario('Lovable Loser — needs to be ALONE in last place', () => {
  const alone = raceState(
    [
      { player: 'p1', racer: 'lovable-loser', pos: 2 },
      { player: 'p2', racer: 'vanilla-01', pos: 10 },
    ],
    'p1',
  );
  const a = applyAction(alone, roll('p1'));
  check(has(a.events, 'token/awarded'), 'scores when alone in last');

  const shared = raceState(
    [
      { player: 'p1', racer: 'lovable-loser', pos: 2 },
      { player: 'p2', racer: 'vanilla-01', pos: 2 },
      { player: 'p3', racer: 'vanilla-02', pos: 10 },
    ],
    'p1',
  );
  const b = applyAction(shared, roll('p1'));
  check(!has(b.events, 'token/awarded'), 'scores nothing when sharing the space');
});

scenario('Gunk — "Other racers get -1 to their main move"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'gunk', pos: 20 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 4);
  check(posOf(state, 'vanilla-01') === 5, 'moved 4, not 5 — goop applied', `pos ${posOf(state, 'vanilla-01')}`);
});

scenario('Duelist — optional, and the DUELIST chooses', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'duelist', pos: 4 },
    ],
    'p1',
  );
  const { state: mid, events } = rollFor(s, 'p1', 3);

  check(mid.pending !== null, 'suspended on a decision');
  check(
    mid.pending?.player === playerId('p2'),
    'the NON-active player (Duelist’s owner) is asked',
    `asked ${String(mid.pending?.player)}`,
  );
  check(has(events, 'decision/requested'), 'decision announced');

  const declined = applyAction(mid, decide('p2', 'pass'));
  check(posOf(declined.state, 'vanilla-01') === 4, 'declining leaves everyone put');
  check(declined.state.queue.length === 0, 'queue drained after declining');
});

scenario('Duelist — the winner moves 2, the loser is untouched', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'duelist', pos: 4 },
    ],
    'p1',
  );
  const { state: mid } = rollFor(s, 'p1', 3);
  const res = applyAction(mid, decide('p2', 'duel'));

  const text = logLines(res.events);
  check(text.includes('DUEL!'), 'duel was rolled');

  const duelistPos = posOf(res.state, 'duelist');
  const otherPos = posOf(res.state, 'vanilla-01');
  const oneAdvanced = duelistPos === 6 || otherPos === 6;
  check(oneAdvanced, 'exactly one duellist advanced 2', `duelist ${duelistPos}, other ${otherPos}`);
  check(duelistPos >= 4 && otherPos >= 4, 'nobody was pushed backwards');
});

scenario('Duelist — the active player may not answer for them', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'duelist', pos: 4 },
    ],
    'p1',
  );
  const { state: mid } = rollFor(s, 'p1', 3);

  let threw = false;
  try {
    applyAction(mid, decide('p1', 'duel'));
  } catch {
    threw = true;
  }
  check(threw, 'p1 answering p2’s decision is rejected');
});

scenario('Timeout auto-answers a pending decision', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'duelist', pos: 4 },
    ],
    'p1',
  );
  const { state: mid } = rollFor(s, 'p1', 3);
  const res = applyAction(mid, { t: 'system/timeout', at: Date.now() });
  const made = res.events.find((e) => e.t === 'decision/made') as { auto: boolean } | undefined;

  check(made?.auto === true, 'marked automatic');
  check(res.state.pending === null, 'no longer blocked');
  check(res.state.queue.length === 0, 'turn ran to completion');
});

scenario('A suspended turn survives a serialization round trip', () => {
  // The Durable Object hibernation case: queue and pending decision must both be plain
  // data, or a resumed room would lose the half-finished turn.
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'duelist', pos: 4 },
    ],
    'p1',
  );
  const { state: mid } = rollFor(s, 'p1', 3);

  const revived = JSON.parse(JSON.stringify(mid)) as GameState;
  check(revived.pending !== null, 'pending survived JSON');
  check(revived.queue.length === mid.queue.length, 'queue survived JSON');

  const a = applyAction(mid, decide('p2', 'duel'));
  const b = applyAction(revived, decide('p2', 'duel'));
  check(
    JSON.stringify(a.state) === JSON.stringify(b.state),
    'resuming from the revived state gives an identical result',
  );
});

scenario('Racers crossing the line are placed', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 27 },
      { player: 'p2', racer: 'vanilla-02', pos: 1 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 5);

  check(posOf(state, 'vanilla-01') === FINISH, 'reached the finish');
  check(has(events, 'racer/finished'), 'finish recorded');
  check(racerAt(state, 'vanilla-01')?.finishedRank === 1, 'placed first');
});

scenario('Coach — "Everyone on my space gets +1 to their main move, including me"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'coach', pos: 5 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 4);
  const rolled = events.find((e) => e.t === 'dice/rolled') as { modifiedBy?: string };
  check(rolled.modifiedBy === racerId('coach'), 'Coach hustles a racer sharing his space');
  check(posOf(state, 'vanilla-01') === 9, 'moved the boosted amount', `pos ${posOf(state, 'vanilla-01')}`);

  const solo = raceState([{ player: 'p1', racer: 'coach', pos: 5 }], 'p1');
  const soloRes = rollFor(solo, 'p1', 4);
  const soloRolled = soloRes.events.find((e) => e.t === 'dice/rolled') as { modifiedBy?: string };
  check(soloRolled.modifiedBy === racerId('coach'), 'and hustles himself too');
});

scenario('Cheerleader — "last place move 2. If I do, I move 1"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'cheerleader', pos: 5 },
      { player: 'p2', racer: 'vanilla-01', pos: 1 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 3, { by: 'p1', choice: 'cheer' });
  check(posOf(state, 'vanilla-01') === 3, 'last place moved 2', `pos ${posOf(state, 'vanilla-01')}`);
  check(posOf(state, 'cheerleader') === 9, 'Cheerleader got her main move plus the +1 bonus', `pos ${posOf(state, 'cheerleader')}`);
});

scenario('Cheerleader — cheering for herself: move 2, then move 1, in that order', () => {
  const s = raceState([{ player: 'p1', racer: 'cheerleader', pos: 1 }], 'p1');
  const asked = applyAction(s, roll('p1'));
  const cheered = applyAction(asked.state, decide('p1', 'cheer'));
  const moves = cheered.events.filter((e) => e.t === 'racer/moved') as { to: number }[];
  check(
    moves[0]?.to === 2 && moves[1]?.to === 3,
    'the +2 cheer resolves before the +1 bonus',
    JSON.stringify(moves.map((m) => m.to)),
  );
});

scenario('Hare — "+2 to my main move", skips it alone in the lead', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'hare', pos: 5 },
      { player: 'p2', racer: 'vanilla-01', pos: 1 },
      { player: 'p3', racer: 'vanilla-02', pos: 10 },
    ],
    'p1',
  );
  const { events } = rollFor(s, 'p1', 4);
  const rolled = events.find((e) => e.t === 'dice/rolled') as { modifiedBy?: string };
  check(rolled.modifiedBy === racerId('hare'), 'Hare gets +2');

  const alone = raceState(
    [
      { player: 'p1', racer: 'hare', pos: 10 },
      { player: 'p2', racer: 'vanilla-01', pos: 1 },
    ],
    'p1',
  );
  const res = applyAction(alone, roll('p1'));
  check(!has(res.events, 'dice/rolled'), 'no roll at all — alone in the lead');
  check(posOf(res.state, 'hare') === 10, 'did not move');
});

scenario('Heckler — "ends their turn within 1 space of where they started"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5, tripped: true },
      { player: 'p2', racer: 'heckler', pos: 20 },
    ],
    'p1',
  );
  const res = applyAction(s, roll('p1'));
  check(posOf(res.state, 'heckler') === 22, 'a barely-moved (tripped) turn earns Heckler +2', `pos ${posOf(res.state, 'heckler')}`);
});

scenario('Inchworm — "rolls a 1... they skip that move and I move 1"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'inchworm', pos: 10 },
    ],
    'p1',
  );
  // A natural roll is never 0 — the only way to reach a final value of 0 is Inchworm
  // cancelling a roll of 1.
  const { state, events } = rollFor(s, 'p1', 0);
  check(posOf(state, 'vanilla-01') === 5, 'the roll of 1 was skipped entirely', `pos ${posOf(state, 'vanilla-01')}`);
  check(posOf(state, 'inchworm') === 11, 'Inchworm wriggles 1', `pos ${posOf(state, 'inchworm')}`);
  check(logLines(events).includes('wriggles'), 'logged');
});

scenario('Lackey — "rolls a 6... I move 2 before they move"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'lackey', pos: 10 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 6);
  check(posOf(state, 'vanilla-01') === 11, 'the roller still moves the full 6', `pos ${posOf(state, 'vanilla-01')}`);
  check(posOf(state, 'lackey') === 12, 'Lackey moves 2', `pos ${posOf(state, 'lackey')}`);
  const moves = events.filter((e) => e.t === 'racer/moved') as { racerId: string }[];
  check(moves[0]?.racerId === racerId('lackey'), 'Lackey moves before the roller', JSON.stringify(moves));
});

scenario('Skipper — "anyone rolls a 1... I go next in turn order"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'skipper', pos: 8 },
      { player: 'p3', racer: 'vanilla-02', pos: 2 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 1);
  check(
    state.phase.t === 'racing' && state.phase.active === playerId('p2'),
    'Skipper cuts in front of p3',
    `active ${state.phase.t === 'racing' ? String(state.phase.active) : '?'}`,
  );
});

scenario('Leaptoad — "skip spaces with other racers on them"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'leaptoad', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 2 },
      { player: 'p3', racer: 'vanilla-02', pos: 3 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 2);
  check(posOf(state, 'leaptoad') === 5, 'hopped clean over both occupied spaces', `pos ${posOf(state, 'leaptoad')}`);
});

scenario('Party Animal — pulls everyone 1 toward him', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'party-animal', pos: 10 },
      { player: 'p2', racer: 'vanilla-01', pos: 5 },
      { player: 'p3', racer: 'vanilla-02', pos: 15 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(posOf(asked.state, 'vanilla-01') === 6, 'pulled 1 toward Party Animal', `pos ${posOf(asked.state, 'vanilla-01')}`);
  check(posOf(asked.state, 'vanilla-02') === 14, 'pulled 1 toward Party Animal', `pos ${posOf(asked.state, 'vanilla-02')}`);
});

scenario('Party Animal — sharing his space after the pull gives +1', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'party-animal', pos: 10 },
      { player: 'p2', racer: 'vanilla-01', pos: 9 },
    ],
    'p1',
  );
  const { events } = rollFor(s, 'p1', 3);
  const rolled = events.find((e) => e.t === 'dice/rolled') as { modifiedBy?: string };
  check(rolled.modifiedBy === racerId('party-animal'), 'the pulled racer now shares his space, giving +1');
});

scenario('Romantic — "anyone stops on a space with exactly one other racer"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'vanilla-02', pos: 8 },
      { player: 'p3', racer: 'romantic', pos: 20 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 3);
  check(posOf(state, 'romantic') === 22, 'Romantic swoons at a pair forming elsewhere', `pos ${posOf(state, 'romantic')}`);
});

scenario('Suckerfish — "when a racer on my space moves, I can move to their new space"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'suckerfish', pos: 5 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 4, { by: 'p2', choice: 'follow' });
  check(posOf(state, 'suckerfish') === 9, 'latched on and followed to the new space', `pos ${posOf(state, 'suckerfish')}`);
});

scenario('Stickler — "can only cross by the exact number... overshoot, they don\'t move"', () => {
  const overshoot = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: FINISH - 2 },
      { player: 'p2', racer: 'stickler', pos: 1 },
    ],
    'p1',
  );
  const { state } = rollFor(overshoot, 'p1', 5);
  check(posOf(state, 'vanilla-01') === FINISH - 2, 'overshooting: no movement at all', `pos ${posOf(state, 'vanilla-01')}`);

  const exact = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: FINISH - 5 },
      { player: 'p2', racer: 'stickler', pos: 1 },
    ],
    'p1',
  );
  const e = rollFor(exact, 'p1', 5);
  check(posOf(e.state, 'vanilla-01') === FINISH, 'the exact amount still crosses', `pos ${posOf(e.state, 'vanilla-01')}`);
});

scenario('Hypnotist — "before my main move, I can warp a racer to my space"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'hypnotist', pos: 10 },
      { player: 'p2', racer: 'vanilla-01', pos: 3 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending !== null, 'asks before rolling');
  const res = applyAction(asked.state, decide('p1', 'warp:vanilla-01'));
  check(posOf(res.state, 'vanilla-01') === 10, 'warped to Hypnotist’s space', `pos ${posOf(res.state, 'vanilla-01')}`);
  check(has(res.events, 'racer/warped'), 'a warp, not a move');
});

scenario('Third Wheel — "warp to any space with exactly 2 racers on it"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'third-wheel', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 12 },
      { player: 'p3', racer: 'vanilla-02', pos: 12 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending !== null, 'asks before rolling');
  const res = applyAction(asked.state, decide('p1', 'warp:12'));
  const warped = res.events.find((e) => e.t === 'racer/warped') as { to: number } | undefined;
  check(warped?.to === 12, 'warped to the pair', `warped to ${String(warped?.to)}`);
  check(has(res.events, 'dice/rolled'), 'still gets the main move after warping');
});

scenario('Flip Flop — "swap spaces with another racer instead of rolling"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'flip-flop', pos: 3 },
      { player: 'p2', racer: 'vanilla-01', pos: 15 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending !== null, 'asks before rolling');
  const res = applyAction(asked.state, decide('p1', 'swap:vanilla-01'));
  check(posOf(res.state, 'flip-flop') === 15, 'flip flopped to their space', `pos ${posOf(res.state, 'flip-flop')}`);
  check(posOf(res.state, 'vanilla-01') === 3, 'and they land on Flip Flop’s old space', `pos ${posOf(res.state, 'vanilla-01')}`);

  const declined = applyAction(asked.state, decide('p1', 'roll'));
  const d = declined.events.find((e) => e.t === 'dice/rolled') as { value: number };
  check(d.value >= 1 && d.value <= 6, 'declining rolls normally', `got ${d.value}`);
});

scenario('Blimp — "+3 before the second corner, -1 on or after it"', () => {
  const before = raceState([{ player: 'p1', racer: 'blimp', pos: 5 }], 'p1');
  const b = rollFor(before, 'p1', 6);
  const rolledBefore = b.events.find((e) => e.t === 'dice/rolled') as {
    value: number;
    natural?: number;
    modifiedBy?: string;
  };
  check(rolledBefore.modifiedBy === racerId('blimp'), 'gets +3 before the corner');
  check(
    rolledBefore.natural === rolledBefore.value - 3,
    'reports the die face alongside the boosted move',
    `natural ${rolledBefore.natural}, value ${rolledBefore.value}`,
  );

  const after = raceState([{ player: 'p1', racer: 'blimp', pos: 20 }], 'p1');
  const a = rollFor(after, 'p1', 1);
  const rolledAfter = a.events.find((e) => e.t === 'dice/rolled') as {
    value: number;
    natural?: number;
    modifiedBy?: string;
  };
  check(rolledAfter.modifiedBy === racerId('blimp'), 'gets -1 on or after the corner');
  check(
    rolledAfter.natural === rolledAfter.value + 1,
    'and when it drags the move down',
    `natural ${rolledAfter.natural}, value ${rolledAfter.value}`,
  );
});

// --- Phase 5, wave 2 ----------------------------------------------------------

scenario('Alchemist — "When I roll a 1 or 2... I can move 4 instead"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'alchemist', pos: 3 },
      { player: 'p2', racer: 'vanilla-01', pos: 20 },
    ],
    'p1',
  );
  const asked = rollUntil(s, 'p1', (r) => pendingDie(r.state) === 2);
  check(asked.state.pending?.player === playerId('p1'), 'asks after rolling a 2');
  // The client puts the die on the table from this event, so it has to come first: being
  // asked about a 2 nobody has seen yet is the wrong way round.
  const thrown = asked.events.findIndex((e) => e.t === 'dice/thrown');
  const question = asked.events.findIndex((e) => e.t === 'decision/requested');
  check(thrown >= 0 && thrown < question, 'the die is thrown before the question', `${thrown} vs ${question}`);

  const transmuted = applyAction(asked.state, decide('p1', 'transmute'));
  check(posOf(transmuted.state, 'alchemist') === 7, 'moves 4 instead', `pos ${posOf(transmuted.state, 'alchemist')}`);
  const settled = transmuted.events.find((e) => e.t === 'dice/rolled') as {
    value: number;
    natural?: number;
    replaced?: boolean;
  };
  check(
    settled.natural === 2 && settled.value === 4 && settled.replaced === true,
    'and the move stands in place of the roll rather than adding to it',
    `natural ${settled.natural}, value ${settled.value}, replaced ${settled.replaced}`,
  );

  const kept = applyAction(asked.state, decide('p1', 'keep'));
  check(posOf(kept.state, 'alchemist') === 5, 'or keeps the 2', `pos ${posOf(kept.state, 'alchemist')}`);

  const high = rollFor(s, 'p1', 5);
  check(!has(high.events, 'decision/requested'), 'a 5 is not asked about');
});

scenario('Copy Cat — "I have the power of the racer currently in the lead"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'copy-cat', pos: 1 },
      { player: 'p2', racer: 'legs', pos: 10 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending?.player === playerId('p1'), 'has Legs’ power, so is asked to jog');
  const jogged = applyAction(asked.state, decide('p1', 'jog'));
  check(posOf(jogged.state, 'copy-cat') === 6, 'and jogs 5', `pos ${posOf(jogged.state, 'copy-cat')}`);

  const goop = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'copy-cat', pos: 5 },
      { player: 'p3', racer: 'gunk', pos: 20 },
    ],
    'p1',
  );
  const gooped = rollUntil(goop, 'p1', (r) =>
    r.events.some((e) => e.t === 'ability/triggered' && e.racerId === racerId('copy-cat')),
  );
  check(logLines(gooped.events).includes('Copy Cat goops'), 'copying Gunk, it goops too — under its own name', logLines(gooped.events));

  const leading = raceState(
    [
      { player: 'p1', racer: 'copy-cat', pos: 12 },
      { player: 'p2', racer: 'legs', pos: 3 },
    ],
    'p1',
  );
  check(applyAction(leading, roll('p1')).state.pending === null, 'alone in the lead, it copies nobody');
});

scenario('Copy Cat — "If there\'s a tie, I pick"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'copy-cat', pos: 1 },
      { player: 'p2', racer: 'legs', pos: 10 },
      { player: 'p3', racer: 'coach', pos: 10 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  const ids = asked.state.pending?.options.map((o) => String(o.id)) ?? [];
  check(ids.includes('copy:legs') && ids.includes('copy:coach'), 'offers both leaders', ids.join(','));

  const picked = applyAction(asked.state, decide('p1', 'copy:legs'));
  check(
    picked.state.pending?.prompt.includes('Jog') === true,
    'picking Legs goes straight on to Legs’ own question',
    picked.state.pending?.prompt,
  );
  const jogged = applyAction(picked.state, decide('p1', 'jog'));
  check(posOf(jogged.state, 'copy-cat') === 6, 'and the power is Legs’', `pos ${posOf(jogged.state, 'copy-cat')}`);
});

scenario('Dicemonger — "Anyone can reroll their main move once per turn"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'dicemonger', pos: 10 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending?.player === playerId('p1'), 'the roller decides, not Dicemonger');

  const rerolled = applyAction(asked.state, decide('p1', 'reroll'));
  check(rerolled.state.pending === null, 'only once per turn — no second offer');
  check(posOf(rerolled.state, 'dicemonger') === 11, '"When another racer does it, I move 1"', `pos ${posOf(rerolled.state, 'dicemonger')}`);
  const moves = rerolled.events.filter((e) => e.t === 'racer/moved') as { racerId: string }[];
  check(moves[0]?.racerId === racerId('dicemonger'), '"I move before they move"');

  const own = raceState([{ player: 'p1', racer: 'dicemonger', pos: 10 }], 'p1');
  const ownAsked = applyAction(own, roll('p1'));
  const ownRerolled = applyAction(ownAsked.state, decide('p1', 'reroll'));
  const d = ownRerolled.events.find((e) => e.t === 'dice/rolled') as { value: number };
  check(posOf(ownRerolled.state, 'dicemonger') === 10 + d.value, 'its own reroll earns no bonus move');
});

scenario('Genius — "If I\'m right, I take another turn after this one"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'genius', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 1 },
    ],
    'p1',
  );
  const right = rollFor(s, 'p1', 3, { by: 'p1', choice: 'predict:3' });
  check(moverAt(right.state) === 'p1', 'a correct prediction goes again', moverAt(right.state));

  const wrong = rollFor(s, 'p1', 4, { by: 'p1', choice: 'predict:3' });
  check(moverAt(wrong.state) === 'p2', 'a wrong one hands on', moverAt(wrong.state));
});

scenario('Egg — "draw 3 new racers from the deck and pick one. I have its powers"', () => {
  // Three seats: two players would be playing the variant, which asks for two racers each
  // and has nothing to do with what Egg does.
  const s = commitState({ p1: ['egg'], p2: ['coach'], p3: ['legs'] }, 1);
  const r1 = applyAction(s, commit('p1', 'egg'));
  const r2 = applyAction(applyAction(r1.state, commit('p2', 'coach')).state, commit('p3', 'legs'));
  const options = r2.state.pending?.options.map((o) => String(o.id).slice('power:'.length)) ?? [];

  check(r2.state.pending?.source === racerId('egg'), 'asks before the race starts');
  check(options.length === 3 && new Set(options).size === 3, 'three different racers', options.join(','));
  check(
    !options.includes('egg') && !options.includes('coach') && !options.includes('legs'),
    'none of them drafted',
  );
  // The client draws each choice as that racer's card, which it can only do from the target.
  const targeted = (r2.state.pending?.options ?? []).every(
    (o, i) => o.target?.t === 'racer' && o.target.racerId === racerId(options[i] ?? ''),
  );
  check(targeted, 'each option names the racer it offers');

  const picked = applyAction(r2.state, decide('p1', `power:${options[0] ?? ''}`));
  check(racerAt(picked.state, 'egg')?.memo['borrowedPower'] === options[0], 'Egg has the chosen power');
});

scenario('Twin — "pick a racer who won a previous race and race with their powers"', () => {
  // p1's Sisyphus won race 1. Twin borrowing it must also get Sisyphus' "before race"
  // chips: "I still get any 'before race' powers."
  const s = commitState({ p1: ['sisyphus', 'twin'], p2: ['coach', 'legs'], p3: ['gunk', 'banana'] }, 2, {
    used: {
      [playerId('p1')]: [racerId('sisyphus')],
      [playerId('p2')]: [racerId('coach')],
      [playerId('p3')]: [racerId('banana')],
    },
    scores: {
      [playerId('p1')]: [{ kind: 'gold', value: 3, raceNo: 1 }],
      [playerId('p2')]: [{ kind: 'silver', value: 1, raceNo: 1 }],
      [playerId('p3')]: [],
    },
  });
  const r1 = applyAction(s, commit('p1', 'twin'));
  const r2 = applyAction(applyAction(r1.state, commit('p2', 'legs')).state, commit('p3', 'gunk'));
  const ids = r2.state.pending?.options.map((o) => String(o.id)) ?? [];
  check(ids.includes('power:sisyphus') && !ids.includes('power:coach'), 'only past winners are offered', ids.join(','));

  const picked = applyAction(r2.state, decide('p1', 'power:sisyphus'));
  check(pointsOf(picked.state, 'p1') === 3 + 4, 'and gets Sisyphus’ 4 chips before the race', `points ${pointsOf(picked.state, 'p1')}`);
});

scenario('Mastermind — "I predict which racer will win"', () => {
  const first = raceState(
    [
      { player: 'p1', racer: 'mastermind', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 3 },
    ],
    'p1',
  );
  const asked = applyAction(first, roll('p1'));
  check(asked.state.pending?.options.length === 2, 'asks at the start of the first turn, any racer', `${asked.state.pending?.options.length}`);

  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 27 },
      { player: 'p2', racer: 'mastermind', pos: 5, memo: { predicted: 'vanilla-01' } },
      { player: 'p3', racer: 'vanilla-02', pos: 1 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 5);
  const ended = events.find((e) => e.t === 'race/ended') as { podium: string[] } | undefined;
  check(
    ended?.podium.join(',') === 'p1,p2',
    '"the race ends immediately and I finish 2nd"',
    ended ? ended.podium.join(',') : 'race did not end',
  );
  check(state.phase.t === 'scored', 'race is over');

  const self = raceState(
    [
      { player: 'p1', racer: 'mastermind', pos: 27, memo: { predicted: 'mastermind' } },
      { player: 'p2', racer: 'vanilla-01', pos: 1 },
    ],
    'p1',
  );
  const selfWin = rollFor(self, 'p1', 5);
  check(pointsOf(selfWin.state, 'p1') === 3 + 1, '"If I predict myself, I can win both 1st and 2nd"', `points ${pointsOf(selfWin.state, 'p1')}`);
});

scenario('Magician — "I can reroll my main move up to two times"', () => {
  const s = raceState([{ player: 'p1', racer: 'magician', pos: 1 }], 'p1');
  const a = applyAction(s, roll('p1'));
  check(a.state.pending?.prompt.includes('2 left') === true, 'offers a reroll', a.state.pending?.prompt);

  const revived = JSON.parse(JSON.stringify(a.state)) as GameState;
  const b = applyAction(revived, decide('p1', 'reroll'));
  check(b.state.pending?.prompt.includes('1 left') === true, 'offers a second, from a JSON-revived state', b.state.pending?.prompt);

  const c = applyAction(b.state, decide('p1', 'reroll'));
  check(c.state.pending === null, 'no third reroll');
  check(has(c.events, 'dice/rolled'), '"I must use whatever my last roll is"');
});

scenario('Rocket Scientist — "double that number. If I do, I trip"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'rocket-scientist', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 20 },
    ],
    'p1',
  );
  const asked = rollUntil(s, 'p1', (r) => pendingDie(r.state) === 3);
  const boom = applyAction(asked.state, decide('p1', 'kablooey'));
  check(posOf(boom.state, 'rocket-scientist') === 7, 'moves double', `pos ${posOf(boom.state, 'rocket-scientist')}`);
  check(racerAt(boom.state, 'rocket-scientist')?.tripped === true, 'and trips');
});

scenario('Sisyphus — "Before my race, I take 4 point chips"', () => {
  const s = commitState({ p1: ['sisyphus'], p2: ['coach'], p3: ['legs'] }, 1);
  const r = applyAction(
    applyAction(applyAction(s, commit('p1', 'sisyphus')).state, commit('p2', 'coach')).state,
    commit('p3', 'legs'),
  );
  check(pointsOf(r.state, 'p1') === 4, 'starts the race with 4 points', `points ${pointsOf(r.state, 'p1')}`);
});

scenario('Sisyphus — "roll a 6... warp to the Start and lose 1 point chip"', () => {
  const base = raceState(
    [
      { player: 'p1', racer: 'sisyphus', pos: 12 },
      { player: 'p2', racer: 'vanilla-01', pos: 1 },
      { player: 'p3', racer: 'coach', pos: 12 },
    ],
    'p1',
  );
  const s: GameState = {
    ...base,
    scores: { ...base.scores, [playerId('p1')]: [{ kind: 'points', value: 4, raceNo: 1 }] },
  };
  const { state, events } = rollUntil(s, 'p1', (r) => has(r.events, 'token/lost'));
  check(posOf(state, 'sisyphus') === START, 'back at the Start', `pos ${posOf(state, 'sisyphus')}`);
  check(pointsOf(state, 'p1') === 3, 'one chip lighter', `points ${pointsOf(state, 'p1')}`);
  check(
    !events.some((e) => e.t === 'racer/moved' && e.racerId === racerId('sisyphus')),
    '"I don\'t get my main move after warping" — not even Coach’s +1',
  );
});

scenario('Scoocher — "When another racer\'s power happens, I move 1"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'gunk', pos: 20 },
      { player: 'p3', racer: 'scoocher', pos: 10 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 3);
  check(posOf(state, 'scoocher') === 11, 'Gunk’s goop scooches 1', `pos ${posOf(state, 'scoocher')}`);
});

scenario('Scoocher — the Huge Baby loop runs once, then ends (rule 8)', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'huge-baby', pos: 5 },
      { player: 'p3', racer: 'scoocher', pos: 4 },
      { player: 'p4', racer: 'gunk', pos: 20 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 1);
  const bounces = events.filter((e) => e.t === 'ability/triggered' && e.text.includes("can't fit past")).length;
  check(posOf(state, 'scoocher') === 4, 'Scoocher ends behind Huge Baby', `pos ${posOf(state, 'scoocher')}`);
  check(bounces === 2, 'bounced once for the goop, once more for the loop, then stopped', `${bounces} bounces`);
});

scenario('Scoocher — a loop that asks a question every lap still ends', () => {
  // Found by the fuzzer: each scooch off Suckerfish's space asks Suckerfish, and each
  // answer is a new action, so a guard scoped to one action never saw the loop repeat.
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p2', racer: 'gunk', pos: 20 },
      { player: 'p3', racer: 'huge-baby', pos: 6 },
      { player: 'p4', racer: 'scoocher', pos: 5 },
      { player: 'p5', racer: 'suckerfish', pos: 5 },
    ],
    'p1',
  );
  let state = rollFor(s, 'p1', 1).state;
  let answers = 0;
  while (state.pending && answers < 50) {
    state = applyAction(state, decide(String(state.pending.player), 'stay')).state;
    answers++;
  }
  check(answers >= 2, 'Suckerfish really is asked on more than one lap', `${answers} answers`);
  check(state.pending === null && moverAt(state) === 'p2', 'the turn finishes', `${answers} answers`);
  check(posOf(state, 'scoocher') === 5, 'with Scoocher back behind Huge Baby', `pos ${posOf(state, 'scoocher')}`);
});

scenario('Romantic — swooning onto an arrow that knocks it back to the pair ends (rule 8)', () => {
  // Found by the fuzzer. Wild Wilds: space 16 is a -4 arrow. Romantic stops beside a pair
  // at 14, swoons to 16 beside another racer, is knocked back to 12, swoons to 14 again...
  const s = raceState(
    [
      { player: 'p1', racer: 'romantic', pos: 12 },
      { player: 'p2', racer: 'vanilla-01', pos: 14 },
      { player: 'p3', racer: 'vanilla-02', pos: 16 },
    ],
    'p1',
    2,
  );
  const { state, events } = rollFor(s, 'p1', 2);
  const swoons = events.filter((e) => e.t === 'ability/triggered' && e.text.includes('swoons')).length;
  check(moverAt(state) === 'p2', 'the turn finishes', moverAt(state));
  check(swoons >= 2 && swoons <= 4, 'the loop ran, but only once round', `${swoons} swoons`);
});

scenario('Skipper — "(Unless I roll a 1 and go again!)"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'skipper', pos: 5 },
      { player: 'p2', racer: 'vanilla-01', pos: 8 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 1);
  check(moverAt(state) === 'p1', 'Skipper goes again', moverAt(state));
});

scenario('Suckerfish can latch on to a move queued by a power that may not ask (Lackey)', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 5 },
      { player: 'p2', racer: 'lackey', pos: 10 },
      { player: 'p3', racer: 'suckerfish', pos: 10 },
    ],
    'p1',
  );
  const { state } = rollFor(s, 'p1', 6, { by: 'p3', choice: 'follow' });
  check(posOf(state, 'lackey') === 12, 'Lackey moves 2', `pos ${posOf(state, 'lackey')}`);
  check(posOf(state, 'suckerfish') === 12, 'Suckerfish follows', `pos ${posOf(state, 'suckerfish')}`);
  check(posOf(state, 'vanilla-01') === 11, 'the roller still moves', `pos ${posOf(state, 'vanilla-01')}`);
});

// --- Phase 6: lobby, bots, rematch ---------------------------------------------

const lobbyWith = (...names: string[]): GameState =>
  names.reduce(
    (s, n) => applyAction(s, { t: 'lobby/join', by: playerId(n), name: n }).state,
    initGame(4242),
  );

const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

scenario('Bots — only the host adds and removes them', () => {
  const s = lobbyWith('host-player', 'guest-player');
  const host = playerId('host-player');
  const guest = playerId('guest-player');

  check(
    legalActions(s, host).some((a) => a.t === 'lobby/addBot') &&
      !legalActions(s, guest).some((a) => a.t === 'lobby/addBot'),
    'the host is offered Add bot; a guest is not',
  );
  check(throws(() => applyAction(s, { t: 'lobby/addBot', by: guest })), 'a guest adding a bot is rejected');

  const added = applyAction(s, { t: 'lobby/addBot', by: host }).state;
  const bot = added.players.find((p) => p.bot);
  check(bot?.id === playerId('bot-1') && bot.name === 'Bot 1', 'seats Bot 1', JSON.stringify(bot));
  check(legalActions(added, playerId('bot-1')).length === 0, 'a bot has nothing to do in the lobby');

  check(
    throws(() => applyAction(added, { t: 'lobby/removeBot', by: host, player: guest })),
    'Remove bot cannot remove a human',
  );
  const removed = applyAction(added, { t: 'lobby/removeBot', by: host, player: playerId('bot-1') }).state;
  check(removed.players.length === 2 && !removed.players.some((p) => p.bot), 'and removes the bot');
});

scenario('Bots — never become host', () => {
  let s = lobbyWith('host-player');
  s = applyAction(s, { t: 'lobby/addBot', by: playerId('host-player') }).state;
  s = applyAction(s, { t: 'lobby/join', by: playerId('late-player'), name: 'Late' }).state;
  s = applyAction(s, { t: 'lobby/leave', by: playerId('host-player') }).state;
  check(
    legalActions(s, playerId('late-player')).some((a) => a.t === 'lobby/start'),
    'when the host leaves, the next human hosts — not the bot seated before them',
  );
});

scenario('Bots — a game with bots plays to the end', () => {
  for (const seed of [11, 22, 33]) {
    const result = playGame({ seed, playerCount: 4, bots: 3 });
    check(result.state.phase.t === 'gameOver', `seed ${seed}: one human, three bots, game over`);
  }
});

scenario('Rematch — back to the lobby with whoever is still here', () => {
  const played = playGame({ seed: 7, playerCount: 3, bots: 1 }).state;
  const away: GameState = {
    ...played,
    players: played.players.map((p) => (p.id === playerId('p2') ? { ...p, connected: false } : p)),
  };

  check(legalActions(away, playerId('p1')).some((a) => a.t === 'lobby/rematch'), 'offered once the game is over');
  check(legalActions(away, playerId('bot-1')).length === 0, 'but not to a bot');

  const { state, events } = applyAction(away, { t: 'lobby/rematch', by: playerId('p1') });
  check(state.phase.t === 'lobby', 'the room is back in its lobby');
  check(
    state.players.map((p) => String(p.id)).join(',') === 'p1,bot-1',
    'the absent player is dropped; the bot stays',
    state.players.map((p) => String(p.id)).join(','),
  );
  check(pointsOf(state, 'p1') === 0 && state.seatOrder.length === 0, 'scores and seats are cleared');
  check(state.seed !== away.seed, 'with a fresh seed');
  check(has(events, 'game/rematch'), 'announced');
  check(throws(() => applyAction(played, { t: 'lobby/rematch', by: playerId('nobody-here') })), 'strangers cannot trigger it');
});

// --- Two-player variant -----------------------------------------------------

scenario('2 players — "snake draft them (ABBAABBA)... do it again, in reverse order"', () => {
  const order = [playerId('A'), playerId('B')];
  const drafted = Array.from({ length: 16 }, (_, pick) => String(currentDrafter(order, pick))).join('');
  check(drafted === 'ABBAABBABAABBAAB', 'ABBAABBA, then BAABBAAB', drafted);

  const three = [playerId('A'), playerId('B'), playerId('C')];
  const normal = Array.from({ length: 12 }, (_, pick) => String(currentDrafter(three, pick))).join('');
  // "Repeat this process, starting with the player to the left of the start player."
  check(normal === 'ABCCBABCAACB', 'and three players snake, then shift a seat', normal);
});

scenario('2 players — a whole game, two racers each', () => {
  const { state } = playGame({ seed: 5150, playerCount: 2, bots: 1 });
  check(state.phase.t === 'gameOver', 'plays to the end');
  const hands = state.seatOrder.map((p) => (state.hands[p] ?? []).length);
  check(hands.every((n) => n === 8), 'both players drafted 8 racers', hands.join(','));
  const used = state.seatOrder.map((p) => (state.used[p] ?? []).length);
  check(used.every((n) => n === 8), 'and raced all of them, two per race', used.join(','));
});

scenario('2 players — "on each player’s first turn, they pick one racer to use"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 1 },
      { player: 'p1', racer: 'vanilla-02', pos: 2 },
      { player: 'p2', racer: 'vanilla-03', pos: 3 },
      { player: 'p2', racer: 'vanilla-04', pos: 4 },
    ],
    'p1',
  );
  check(s.board.length === 4, 'four racers on the track');

  const offered = legalActions(s, playerId('p1'));
  check(
    offered.length === 2 && offered.every((a) => a.t === 'race/roll'),
    'either racer may go first',
    `${offered.length} options`,
  );
  check(throws(() => applyAction(s, roll('p1'))), 'but the player has to say which');

  // First turn: one racer, then the turn passes.
  const first = applyAction(s, roll('p1', 'vanilla-02'));
  check(moverAt(first.state) === 'p2', 'one racer, then it is p2’s turn', moverAt(first.state));

  const second = applyAction(first.state, roll('p2', 'vanilla-03'));
  check(moverAt(second.state) === 'p1', 'p2’s opener is one racer too', moverAt(second.state));

  // Second turn round: both racers, in the order the player wants.
  const both = applyAction(second.state, roll('p1', 'vanilla-01'));
  check(moverAt(both.state) === 'p1', 'now p1 keeps the turn for their second racer', moverAt(both.state));
  const left = both.state.phase.t === 'racing' ? [...both.state.phase.toMove].map(String) : [];
  check(left.join(',') === 'vanilla-02', 'and it is the one that has not gone', left.join(','));

  const passed = applyAction(both.state, roll('p1', 'vanilla-02'));
  check(moverAt(passed.state) === 'p2', 'only then does the turn pass', moverAt(passed.state));
  check(
    throws(() => applyAction(both.state, roll('p1', 'vanilla-01'))),
    'a racer cannot go twice in one turn',
  );
});

scenario('2 players — "the player who received the lower number of points goes first"', () => {
  let s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: FINISH - 1 },
      { player: 'p1', racer: 'vanilla-02', pos: FINISH - 1 },
      { player: 'p2', racer: 'vanilla-03', pos: 1 },
      { player: 'p2', racer: 'vanilla-04', pos: 2 },
    ],
    'p1',
  );

  // Play it out: p1's two racers are on the line, so p1 takes both cups.
  for (let guard = 0; guard < 20 && s.phase.t === 'racing'; guard++) {
    const who = s.phase.active;
    const options = legalActions(s, who).filter((a) => a.t === 'race/roll');
    const next = options[0];
    if (!next) break;
    s = applyAction(s, next).state;
  }

  check(s.phase.t === 'scored', 'the race is over', s.phase.t);
  check(pointsOf(s, 'p1') > pointsOf(s, 'p2'), 'p1 scored more', `${pointsOf(s, 'p1')} vs ${pointsOf(s, 'p2')}`);
  check(String(s.trailingPlayer) === 'p2', 'so p2 leads off the next race', String(s.trailingPlayer));
});

// --- Character sets -----------------------------------------------------------

const toggle = (by: string, set: CharacterSetId): Action => ({ t: 'lobby/toggleSet', by: playerId(by), set });

scenario('Sets — a new room drafts from the classic set, and the host can mix in Dota', () => {
  const s = lobbyWith('p1', 'p2', 'p3');
  check(s.racerSets.join(',') === 'classic', 'classic by default', s.racerSets.join(','));

  const both = applyAction(s, toggle('p1', 'dota'));
  check(both.state.racerSets.join(',') === 'classic,dota', 'Dota added', both.state.racerSets.join(','));
  check(has(both.events, 'lobby/setsChanged'), 'announced');

  const dotaOnly = applyAction(both.state, toggle('p1', 'classic')).state;
  check(dotaOnly.racerSets.join(',') === 'dota', 'classic taken out', dotaOnly.racerSets.join(','));

  check(throws(() => applyAction(dotaOnly, toggle('p1', 'dota'))), 'the last set cannot be taken out');
  const offered = legalActions(dotaOnly, playerId('p1')).filter((a) => a.t === 'lobby/toggleSet');
  check(
    offered.length === 1 && offered[0]?.t === 'lobby/toggleSet' && offered[0].set === 'classic',
    'so the host is only offered adding classic back',
    JSON.stringify(offered),
  );
  check(throws(() => applyAction(s, toggle('p2', 'dota'))), 'only the host picks sets');
  check(
    legalActions(s, playerId('p2')).every((a) => a.t !== 'lobby/toggleSet'),
    'and nobody else is offered it',
  );
});

scenario('Sets — Dota alone has 16 racers: enough for four players, not five', () => {
  const lobby = lobbyWith('p1', 'p2', 'p3', 'p4');
  const four = applyAction(applyAction(lobby, toggle('p1', 'dota')).state, toggle('p1', 'classic')).state;
  check(
    legalActions(four, playerId('p1')).some((a) => a.t === 'lobby/start'),
    'four players may start',
  );

  const five = applyAction(four, { t: 'lobby/join', by: playerId('p5'), name: 'P5' }).state;
  check(
    legalActions(five, playerId('p1')).every((a) => a.t !== 'lobby/start'),
    'five players are not offered Start',
  );
  check(throws(() => applyAction(five, { t: 'lobby/start', by: playerId('p1') })), 'and cannot start');

  const mixed = applyAction(five, toggle('p1', 'classic')).state;
  check(
    legalActions(mixed, playerId('p1')).some((a) => a.t === 'lobby/start'),
    'adding classic back makes room for them',
  );
});

scenario('Sets — the draft deals only from the chosen sets', () => {
  const dota = playGame({ seed: 9001, playerCount: 3, sets: ['dota'] }).state;
  const drafted = Object.values(dota.hands).flat();
  check(drafted.length === 12, 'three full hands', String(drafted.length));
  check(
    drafted.every((r) => racerSet(r) === 'dota'),
    'every one of them a Dota racer',
    drafted.filter((r) => racerSet(r) !== 'dota').join(','),
  );

  const mixed = playGame({ seed: 9002, playerCount: 6, sets: ['classic', 'dota'] }).state;
  const pool = Object.values(mixed.hands).flat();
  check(pool.length === 24, 'six full hands from the mixed deck', String(pool.length));
  check(pool.every((r) => racerSet(r) !== undefined), 'all real racers');
  check(mixed.racerSets.join(',') === 'classic,dota', 'the choice survives the game');

  const rematch = applyAction(dota, { t: 'lobby/rematch', by: playerId('p1') }).state;
  check(rematch.racerSets.join(',') === 'dota', 'and a rematch keeps it', rematch.racerSets.join(','));
});

// --- Dota racers --------------------------------------------------------------

const withChips = (s: GameState, player: string, value: number): GameState => ({
  ...s,
  scores: { ...s.scores, [playerId(player)]: [pointsToken(value, 1)] },
});

scenario('Bounty Hunter — "I steal 1 point" from the one racer I stop with', () => {
  const s = withChips(
    raceState(
      [
        { player: 'p1', racer: 'bounty-hunter', pos: 1 },
        { player: 'p2', racer: 'vanilla-01', pos: 4 },
      ],
      'p1',
    ),
    'p2',
    2,
  );
  const { state, events } = rollFor(s, 'p1', 3);
  check(pointsOf(state, 'p1') === 1, 'Bounty Hunter gains 1', String(pointsOf(state, 'p1')));
  check(pointsOf(state, 'p2') === 1, 'the victim loses 1', String(pointsOf(state, 'p2')));
  check(logLines(events).includes('pocket'), 'logged');

  const broke = rollFor({ ...s, scores: { ...s.scores, [playerId('p2')]: [] } }, 'p1', 3);
  check(pointsOf(broke.state, 'p1') === 0, 'nothing to steal from an empty pocket');
  check(!logLines(broke.events).includes('pocket'), 'and nothing logged');
});

scenario('Spirit Breaker — whoever it passes rolls, and trips on a 1', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'spirit-breaker', pos: 1 },
      { player: 'p2', racer: 'vanilla-01', pos: 3 },
    ],
    'p1',
  );
  const bashed = rollUntil(s, 'p1', (r) => posOf(r.state, 'spirit-breaker') > 3 && racerAt(r.state, 'vanilla-01')?.tripped === true);
  check(logLines(bashed.events).includes('rolls a 1'), 'a 1 trips them', logLines(bashed.events));

  const missed = rollUntil(s, 'p1', (r) => posOf(r.state, 'spirit-breaker') > 3 && racerAt(r.state, 'vanilla-01')?.tripped === false);
  check(logLines(missed.events).includes('keeps their feet'), 'anything else does not', logLines(missed.events));

  const short = rollFor(s, 'p1', 1);
  check(!logLines(short.events).includes('rolls'), 'no pass, no roll');
});

scenario('Earthshaker — skips the main move to trip its space, moving 2 per trip', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'earthshaker', pos: 3 },
      { player: 'p2', racer: 'vanilla-01', pos: 3 },
      { player: 'p3', racer: 'vanilla-02', pos: 3, tripped: true },
      { player: 'p4', racer: 'vanilla-03', pos: 3 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending?.prompt.includes('Echo Slam') === true, 'asks before rolling');

  const slam = applyAction(asked.state, decide('p1', 'slam'));
  check(racerAt(slam.state, 'vanilla-01')?.tripped === true, 'trips the racers on its space');
  check(posOf(slam.state, 'earthshaker') === 7, 'two fresh trips: moves 4 — the one already down earns nothing', `pos ${posOf(slam.state, 'earthshaker')}`);
  check(!has(slam.events, 'dice/thrown'), 'and never rolls');

  const declined = applyAction(asked.state, decide('p1', 'roll'));
  check(has(declined.events, 'dice/rolled'), 'declining rolls as normal');

  const down = applyAction({ ...s, board: s.board.map((r) => (String(r.racerId) === 'earthshaker' ? { ...r, tripped: true } : r)) }, roll('p1'));
  check(down.state.pending === null, 'a tripped Earthshaker has no main move to give up');
});

scenario('Tidehunter — rolls when tripped, and gets straight up on a 4+', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'tidehunter', pos: 1 },
      { player: 'p2', racer: 'banana', pos: 3 },
    ],
    'p1',
  );
  const passedBanana = (r: { state: GameState; events: readonly GameEvent[] }): boolean =>
    has(r.events, 'racer/tripped') && posOf(r.state, 'tidehunter') > 3;
  const up = rollUntil(s, 'p1', (r) => passedBanana(r) && racerAt(r.state, 'tidehunter')?.tripped === false);
  check(has(up.events, 'racer/stoodUp'), 'stands up', logLines(up.events));

  const down = rollUntil(s, 'p1', (r) => passedBanana(r) && racerAt(r.state, 'tidehunter')?.tripped === true);
  check(logLines(down.events).includes('stays down'), 'or stays down', logLines(down.events));
});

scenario('Templar Assassin — "I ignore the first 3 trips I receive"', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'templar-assassin', pos: 1 },
      { player: 'p2', racer: 'banana', pos: 3 },
    ],
    'p1',
  );
  const first = rollFor(s, 'p1', 5);
  check(racerAt(first.state, 'templar-assassin')?.tripped === false, 'passes Banana still standing');
  check(!has(first.events, 'racer/tripped'), 'the trip never happened');
  check(logLines(first.events).includes('2 left'), 'two refractions left', logLines(first.events));

  const spent = raceState(
    [
      { player: 'p1', racer: 'templar-assassin', pos: 1, memo: { refractions: 3 } },
      { player: 'p2', racer: 'banana', pos: 3 },
    ],
    'p1',
  );
  check(racerAt(rollFor(spent, 'p1', 5).state, 'templar-assassin')?.tripped === true, 'the fourth trip lands');
});

scenario('Anti-Mage — can skip the main move to warp up to 3 ahead', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'anti-mage', pos: 5 },
      { player: 'p2', racer: 'banana', pos: 6 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  const ids = asked.state.pending?.options.map((o) => String(o.id)).join(',');
  check(ids === 'blink:6,blink:7,blink:8,roll', 'offers the next three spaces', ids);

  const blinked = applyAction(asked.state, decide('p1', 'blink:8'));
  check(posOf(blinked.state, 'anti-mage') === 8, 'warps', `pos ${posOf(blinked.state, 'anti-mage')}`);
  check(!has(blinked.events, 'dice/thrown'), 'without rolling');
  check(racerAt(blinked.state, 'anti-mage')?.tripped === false, 'a warp passes nobody — Banana has no say');
  check(moverAt(blinked.state) === 'p2', 'and the turn is over');
});

scenario('Faceless Void — once per race, trips everyone within 5', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'faceless-void', pos: 10 },
      { player: 'p2', racer: 'vanilla-01', pos: 5 },
      { player: 'p3', racer: 'vanilla-02', pos: 15 },
      { player: 'p4', racer: 'vanilla-03', pos: 16 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending?.options[0]?.label === 'Trip 2', 'two in the bubble', asked.state.pending?.options[0]?.label);

  const chrono = applyAction(asked.state, decide('p1', 'chrono'));
  check(racerAt(chrono.state, 'vanilla-01')?.tripped === true, '5 behind: tripped');
  check(racerAt(chrono.state, 'vanilla-02')?.tripped === true, '5 ahead: tripped');
  check(racerAt(chrono.state, 'vanilla-03')?.tripped === false, '6 ahead: safe');
  check(has(chrono.events, 'dice/rolled'), 'and Void still takes its main move');

  const used = raceState(
    [
      { player: 'p1', racer: 'faceless-void', pos: 10, memo: { chronoUsed: true } },
      { player: 'p2', racer: 'vanilla-01', pos: 5 },
    ],
    'p1',
  );
  check(applyAction(used, roll('p1')).state.pending === null, 'not offered a second time');
});

scenario('Silencer — once per race, everyone else loses their powers for their next turn', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'silencer', pos: 0 },
      { player: 'p2', racer: 'legs', pos: 0 },
      { player: 'p3', racer: 'gunk', pos: 0 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending?.prompt.includes('Global Silence') === true, 'offered before the main move');
  const hushed = applyAction(asked.state, decide('p1', 'silence'));
  check(logLines(hushed.events).includes('goops'), "Gunk's goop still works on Silencer's turn", logLines(hushed.events));

  const legsTurn = applyAction(hushed.state, roll('p2'));
  check(legsTurn.state.pending === null, "Legs isn't offered its jog");
  check(has(legsTurn.events, 'dice/rolled'), 'it just rolls');
  check(racerAt(legsTurn.state, 'legs')?.memo['silenced'] === undefined, 'and the silence lifts after that turn');
  check(racerAt(legsTurn.state, 'gunk')?.memo['silenced'] === true, "Gunk's turn is still to come");

  const again = raceState([{ player: 'p1', racer: 'silencer', pos: 0, memo: { silenceUsed: true } }, { player: 'p2', racer: 'legs', pos: 0 }], 'p1');
  check(applyAction(again, roll('p1')).state.pending === null, 'not offered a second time');
});

scenario('Kunkka — after the main move, can warp back to where it started', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'kunkka', pos: 3 },
      { player: 'p2', racer: 'vanilla-01', pos: 20 },
    ],
    'p1',
  );
  const back = rollFor(s, 'p1', 4, { by: 'p1', choice: 'return' });
  check(posOf(back.state, 'kunkka') === 3, 'back on the X', `pos ${posOf(back.state, 'kunkka')}`);
  check(has(back.events, 'racer/warped'), 'by warping');

  const stay = rollFor(s, 'p1', 4, { by: 'p1', choice: 'stay' });
  check(posOf(stay.state, 'kunkka') === 7, 'or it stays', `pos ${posOf(stay.state, 'kunkka')}`);
});

scenario('Omniknight — other racers within 3 get -2 to their main move', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 3 },
      { player: 'p2', racer: 'omniknight', pos: 6 },
    ],
    'p1',
  );
  const near = rollFor(s, 'p1', 3);
  const rolled = near.events.find((e) => e.t === 'dice/rolled') as { natural?: number };
  check(rolled.natural === 5, 'a 5 becomes a move of 3', JSON.stringify(rolled));

  const far = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 2 },
      { player: 'p2', racer: 'omniknight', pos: 6 },
    ],
    'p1',
  );
  check(!logLines(rollFor(far, 'p1', 3).events).includes('aura'), '4 away is out of range');
});

scenario('Ogre Magi — a 1 or 2 can multicast into another turn', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'ogre-magi', pos: 3 },
      { player: 'p2', racer: 'vanilla-01', pos: 3 },
    ],
    'p1',
  );
  const low = rollUntil(s, 'p1', (r) => r.state.pending?.prompt.includes('Multicast') === true);
  const die = pendingDie(low.state);
  check(die === 1 || die === 2, 'asked on a low roll', String(die));
  const again = applyAction(low.state, decide('p1', 'multicast'));
  check(moverAt(again.state) === 'p1', 'Ogre Magi goes again', moverAt(again.state));

  const high = rollFor(s, 'p1', 5);
  check(high.state.pending === null && moverAt(high.state) === 'p2', 'a 5 just moves');
});

scenario('Morphling — has the power of whoever is last', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'morphling', pos: 5 },
      { player: 'p2', racer: 'vanilla-01', pos: 10 },
      { player: 'p3', racer: 'gunk', pos: 2 },
    ],
    'p2',
  );
  const { events } = rollFor(s, 'p2', 3);
  const rolled = events.find((e) => e.t === 'dice/rolled') as { natural?: number };
  check(rolled.natural === 5, 'Gunk and a Gunk-shaped Morphling: -2', JSON.stringify(rolled));

  const tied = raceState(
    [
      { player: 'p1', racer: 'morphling', pos: 5 },
      { player: 'p2', racer: 'legs', pos: 2 },
      { player: 'p3', racer: 'gunk', pos: 2 },
    ],
    'p1',
  );
  const asked = applyAction(tied, roll('p1'));
  check(asked.state.pending?.prompt.includes('Last place is tied') === true, 'a tie for last is its pick');
  const legs = applyAction(asked.state, decide('p1', 'copy:legs'));
  check(legs.state.pending?.prompt.includes('Jog') === true, "and it gets that racer's power", legs.state.pending?.prompt);
});

scenario('Alchemist (Dota) — double points from star spaces and cups', () => {
  const star = raceState(
    [
      { player: 'p1', racer: 'dota-alchemist', pos: 0 },
      { player: 'p2', racer: 'vanilla-01', pos: 20 },
    ],
    'p1',
    2,
  );
  const landed = rollFor(star, 'p1', 1);
  check(pointsOf(landed.state, 'p1') === 2, "the Wild Wilds' 1-point star pays 2", String(pointsOf(landed.state, 'p1')));

  let s = raceState(
    [
      { player: 'p1', racer: 'dota-alchemist', pos: FINISH - 1 },
      { player: 'p2', racer: 'vanilla-01', pos: FINISH - 1 },
    ],
    'p1',
  );
  s = applyAction(s, roll('p1')).state;
  s = applyAction(s, roll('p2')).state;
  check(s.phase.t === 'scored', 'the race is over', s.phase.t);
  check(pointsOf(s, 'p1') === 6, 'a 3-point gold cup pays 6', String(pointsOf(s, 'p1')));
  check(pointsOf(s, 'p2') === 1, 'the silver is untouched', String(pointsOf(s, 'p2')));
});

scenario('Legion Commander — DUEL! after the main move; the winner gets +1 for the race', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'legion-commander', pos: 3 },
      { player: 'p2', racer: 'vanilla-01', pos: 7 },
    ],
    'p1',
  );
  const duel = rollFor(s, 'p1', 4, { by: 'p1', choice: 'duel:vanilla-01' });
  const bonuses = ['legion-commander', 'vanilla-01'].map((r) => racerAt(duel.state, r)?.memo['mainMoveBonus'] ?? 0);
  check(bonuses.filter((b) => b === 1).length === 1, 'exactly one of them wins +1', bonuses.join(','));
  check(logLines(duel.events).includes('DUEL!'), 'logged');

  const prize = raceState(
    [
      { player: 'p1', racer: 'vanilla-01', pos: 3, memo: { mainMoveBonus: 1 } },
      { player: 'p2', racer: 'vanilla-02', pos: 20 },
    ],
    'p1',
  );
  const next = applyAction(prize, roll('p1'));
  const rolled = next.events.find((e) => e.t === 'dice/rolled') as { value: number; natural?: number };
  check(rolled.value === (rolled.natural ?? NaN) + 1, 'and every main move after it is one longer', JSON.stringify(rolled));
});

scenario('Oracle — predicts who trips first; right is worth 3', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'oracle', pos: 0 },
      { player: 'p2', racer: 'vanilla-01', pos: 0 },
    ],
    'p1',
  );
  const asked = applyAction(s, roll('p1'));
  check(asked.state.pending?.prompt === 'Who will trip first?', 'asks on its first turn');
  check(asked.state.pending?.options.length === 2, 'anyone may be named, itself included');

  const board = (prediction: string): GameState =>
    raceState(
      [
        { player: 'p1', racer: 'oracle', pos: 0, memo: { prediction } },
        { player: 'p2', racer: 'vanilla-01', pos: 1 },
        { player: 'p3', racer: 'banana', pos: 3 },
      ],
      'p2',
    );
  const right = rollFor(board('vanilla-01'), 'p2', 5);
  check(pointsOf(right.state, 'p1') === 3, 'called it: +3', String(pointsOf(right.state, 'p1')));

  const wrong = rollFor(board('banana'), 'p2', 5);
  check(pointsOf(wrong.state, 'p1') === 0, 'wrong: nothing');
  check(racerAt(wrong.state, 'oracle')?.memo['foreseen'] === true, 'and the prediction is spent');
});

scenario('Storm Spirit — -1 to the main move, and every move is a warp', () => {
  const s = raceState(
    [
      { player: 'p1', racer: 'storm-spirit', pos: 1 },
      { player: 'p2', racer: 'banana', pos: 3 },
    ],
    'p1',
  );
  const { state, events } = rollFor(s, 'p1', 5);
  const rolled = events.find((e) => e.t === 'dice/rolled') as { natural?: number };
  check(rolled.natural === 6, 'a 6 is a move of 5', JSON.stringify(rolled));
  check(posOf(state, 'storm-spirit') === 6, 'lands 5 ahead');
  check(has(events, 'racer/warped') && !events.some((e) => e.t === 'racer/moved' && String(e.racerId) === 'storm-spirit'), 'by warping');
  check(!has(events, 'racer/passed') && racerAt(state, 'storm-spirit')?.tripped === false, 'so it passes nobody — no Banana trip');
});

// --- Report -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL PASS');
