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

import { applyAction, initGame } from '../reducer/index.js';
import type { Action } from '../actions.js';
import type { GameEvent } from '../events.js';
import { choiceId, playerId, racerId } from '../ids.js';
import { FINISH, START } from '../tracks/index.js';
import type { GameState, RacerState } from '../state.js';

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
}

/** Builds a mid-race state on the Mild Mile, whose spaces are all inert. */
function raceState(placements: readonly Placement[], active: string, raceNo: 1 | 3 = 1): GameState {
  const base = initGame(4242);
  const players = placements.map((p) => playerId(p.player));

  const board: RacerState[] = placements.map((p) => ({
    owner: playerId(p.player),
    racerId: racerId(p.racer),
    pos: p.pos,
    tripped: p.tripped ?? false,
    eliminated: false,
    eliminationOrder: 0,
    finishedRank: null,
    memo: {},
  }));

  return {
    ...base,
    players: players.map((id, i) => ({ id, name: `P${i + 1}`, connected: true })),
    seatOrder: players,
    hands: Object.fromEntries(placements.map((p) => [p.player, [racerId(p.racer)]])),
    used: Object.fromEntries(placements.map((p) => [p.player, [racerId(p.racer)]])),
    scores: Object.fromEntries(players.map((p) => [p, []])),
    phase: {
      t: 'racing',
      raceNo,
      active: playerId(active),
      finished: [],
      stalledTurns: 0,
      claimedSpaces: [],
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

const roll = (by: string): Action => ({ t: 'race/roll', by: playerId(by) });
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

// --- Report -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL PASS');
