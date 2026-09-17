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
      nextUp: null,
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
  const rolledBefore = b.events.find((e) => e.t === 'dice/rolled') as { modifiedBy?: string };
  check(rolledBefore.modifiedBy === racerId('blimp'), 'gets +3 before the corner');

  const after = raceState([{ player: 'p1', racer: 'blimp', pos: 20 }], 'p1');
  const a = rollFor(after, 'p1', 1);
  const rolledAfter = a.events.find((e) => e.t === 'dice/rolled') as { modifiedBy?: string };
  check(rolledAfter.modifiedBy === racerId('blimp'), 'gets -1 on or after the corner');
});

// --- Report -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL PASS');
