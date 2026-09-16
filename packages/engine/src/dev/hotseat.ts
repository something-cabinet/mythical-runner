/**
 * Hot-seat harness — the phase 1 gate.
 *
 * Drives a whole game through the reducer with scripted players who always take the first
 * legal action available to them. That is enough to prove the state machine terminates
 * and that every phase hands off to the next, without needing a server or a UI.
 *
 * It doubles as the seed of the fuzzer: swap "first legal action" for "random legal
 * action" and run it thousands of times.
 *
 *   npx tsc && node dist/dev/hotseat.js [seed] [playerCount]
 */

import { applyAction, initGame, legalActions } from '../reducer/index.js';
import { racerName } from '../characters/registry.js';
import type { Action } from '../actions.js';
import type { GameEvent } from '../events.js';
import { playerId, type PlayerId } from '../ids.js';
import { totalPoints } from '../scoring.js';
import type { GameState } from '../state.js';

export interface PlayOptions {
  readonly seed: number;
  readonly playerCount: number;
  /** Picks among the legal actions. Defaults to "first". */
  readonly choose?: (options: Action[], state: GameState) => Action;
  /** Safety valve: a bug that fails to advance the phase would otherwise hang. */
  readonly maxActions?: number;
}

export interface PlayResult {
  readonly state: GameState;
  readonly events: GameEvent[];
  readonly actions: Action[];
}

/** Runs a complete game and returns the final state plus the full action and event logs. */
export function playGame(opts: PlayOptions): PlayResult {
  const { seed, playerCount } = opts;
  const choose = opts.choose ?? ((options) => options[0] as Action);
  const maxActions = opts.maxActions ?? 20000;

  const players: PlayerId[] = Array.from({ length: playerCount }, (_, i) =>
    playerId(`p${i + 1}`),
  );

  let state = initGame(seed);
  const events: GameEvent[] = [];
  const actions: Action[] = [];

  const apply = (action: Action): void => {
    const res = applyAction(state, action);
    state = res.state;
    events.push(...res.events);
    actions.push(action);
  };

  for (const [i, p] of players.entries()) {
    apply({ t: 'lobby/join', by: p, name: `Player ${i + 1}` });
  }
  apply({ t: 'lobby/start', by: players[0] as PlayerId });

  while (state.phase.t !== 'gameOver') {
    if (actions.length > maxActions) {
      throw new Error(`game did not terminate within ${maxActions} actions`);
    }

    // Find someone with something to do. Order matters only for determinism.
    let acted = false;
    for (const p of players) {
      const options = legalActions(state, p);
      if (options.length === 0) continue;
      apply(choose(options, state));
      acted = true;
      break;
    }
    if (!acted) {
      throw new Error(`deadlock: nobody has a legal action in phase '${state.phase.t}'`);
    }
  }

  return { state, events, actions };
}

/** Renders an event as a line of game log, the same way the client will. */
export function describe(e: GameEvent): string | null {
  switch (e.t) {
    case 'player/joined':
      return `${e.name} joined.`;
    case 'game/started':
      return `Game started with ${e.seatOrder.length} players.`;
    case 'draft/rolled':
      return `${e.player} rolled ${e.value} for draft order.`;
    case 'draft/orderSet':
      return `Draft order: ${e.order.join(' -> ')}`;
    case 'draft/picked':
      return `${e.player} drafted ${racerName(e.racerId)}.`;
    case 'race/started':
      return `\n=== Race ${e.raceNo} on the ${e.trackId} ===`;
    case 'race/revealed':
      return `Entries: ${e.picks.map((p) => `${p.player}=${racerName(p.racerId)}`).join(', ')}`;
    case 'turnOrder/rolled':
      return `Roll-off: ${e.rolls.map((r) => `${r.player}=${r.value}`).join(' ')} -> ${e.first} goes first.`;
    case 'dice/rolled':
      return `  ${e.player} rolls ${e.value} (${racerName(e.racerId)})`;
    case 'racer/stoodUp':
      return `  ${racerName(e.racerId)} gets back up.`;
    case 'ability/triggered':
      return `  ${e.text}`;
    case 'token/awarded':
      return `  ${e.player} takes a ${e.token.kind} worth ${e.token.value}.`;
    case 'racer/finished':
      return `  ${racerName(e.racerId)} finishes #${e.rank} for ${e.player}!`;
    case 'race/ended':
      return `Race ${e.raceNo} over${e.byStalemate ? ' (stalemate)' : ''}.`;
    case 'game/ended':
      return `\n=== ${e.winners.join(' & ')} wins ===`;
    // Per-step movement and turn banners are too noisy for a summary log.
    default:
      return null;
  }
}

function main(): void {
  const seed = Number(process.argv[2] ?? 20260916);
  const playerCount = Number(process.argv[3] ?? 4);

  const { state, events, actions } = playGame({ seed, playerCount });

  for (const e of events) {
    const line = describe(e);
    if (line !== null) console.log(line);
  }

  console.log('\nFinal scores:');
  for (const p of state.seatOrder) {
    const tokens = state.scores[p] ?? [];
    const breakdown = tokens.map((t) => `${t.kind}:${t.value}`).join(' ') || '-';
    console.log(`  ${p}  ${String(totalPoints(tokens)).padStart(3)}   ${breakdown}`);
  }
  console.log(`\n${actions.length} actions, ${events.length} events, step ${state.step}.`);

  // Prove the action log really is a replay: re-running it from a fresh game with the
  // same seed must reproduce a byte-identical final state. If this ever fails, some
  // non-determinism has crept into the reducer.
  const replayed = replay(seed, actions);
  const identical = JSON.stringify(replayed) === JSON.stringify(state);
  console.log(identical ? 'Replay: identical.' : 'Replay: MISMATCH');
  if (!identical) process.exit(1);
}

/** Re-applies a recorded action log to a fresh game. */
export function replay(seed: number, actions: readonly Action[]): GameState {
  let state = initGame(seed);
  for (const a of actions) state = applyAction(state, a).state;
  return state;
}

// Only run as a script, not when imported by tests.
const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1]?.endsWith('hotseat.js') === true;
if (invokedDirectly) main();
