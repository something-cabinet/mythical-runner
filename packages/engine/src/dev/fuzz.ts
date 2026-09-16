/**
 * Fuzz harness.
 *
 * Plays many complete games with randomly chosen legal actions, hunting for the two
 * failure modes that matter: crashes, and races that never terminate. Also reports the
 * distribution of winners by seat, which is how positional bias shows up.
 *
 *   npx tsc && node dist/dev/fuzz.js [games] [seed]
 */

import type { Action } from '../actions.js';
import { playGame, replay } from './hotseat.js';
import { makeRng } from '../rng.js';
import { totalPoints } from '../scoring.js';
import { MAX_PLAYERS, MIN_PLAYERS } from '../state.js';
import type { PlayerId } from '../ids.js';

interface Failure {
  readonly seed: number;
  readonly playerCount: number;
  readonly error: string;
}

export function fuzz(games: number, baseSeed: number): void {
  const failures: Failure[] = [];
  const winsBySeat = new Map<number, number>();
  const winsByCount = new Map<number, number[]>();
  let replayMismatches = 0;
  let stalemates = 0;
  let totalActions = 0;
  let timeoutGames = 0;
  let autoDecisions = 0;

  for (let g = 0; g < games; g++) {
    const seed = (baseSeed + g * 7919) >>> 0;
    const pick = makeRng(seed, 0xffff);
    const playerCount = MIN_PLAYERS + pick.nextInt(MAX_PLAYERS - MIN_PLAYERS + 1);

    try {
      const rng = makeRng(seed, 0x1234);
      // A third of games are played with a flaky, distracted table.
      const timeoutRate = g % 3 === 0 ? 0.15 : 0;
      const result = playGame({
        seed,
        playerCount,
        timeoutRate,
        choose: (options: Action[]) => options[rng.nextInt(options.length)] as Action,
      });
      timeoutGames += timeoutRate > 0 ? 1 : 0;
      autoDecisions += result.events.filter((e) => e.t === 'decision/made' && e.auto).length;

      totalActions += result.actions.length;
      stalemates += result.events.filter((e) => e.t === 'race/ended' && e.byStalemate).length;

      if (JSON.stringify(replay(seed, result.actions)) !== JSON.stringify(result.state)) {
        replayMismatches++;
      }

      const { state } = result;
      if (state.phase.t !== 'gameOver') throw new Error('ended outside gameOver');

      // Verify the declared winners really do hold the top score.
      const scores = state.seatOrder.map((p: PlayerId) => totalPoints(state.scores[p] ?? []));
      const best = Math.max(...scores);
      for (const w of state.phase.winners) {
        if (totalPoints(state.scores[w] ?? []) !== best) {
          throw new Error(`declared winner ${w} does not hold the top score`);
        }
      }

      for (const w of state.phase.winners) {
        const seat = state.seatOrder.indexOf(w);
        winsBySeat.set(seat, (winsBySeat.get(seat) ?? 0) + 1);
        const arr = winsByCount.get(playerCount) ?? [];
        arr[seat] = (arr[seat] ?? 0) + 1;
        winsByCount.set(playerCount, arr);
      }
    } catch (err) {
      failures.push({
        seed,
        playerCount,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(`games:            ${games}`);
  console.log(`failures:         ${failures.length}`);
  console.log(`replay mismatch:  ${replayMismatches}`);
  console.log(`stalemate races:  ${stalemates}`);
  console.log(`avg actions/game: ${(totalActions / Math.max(1, games - failures.length)).toFixed(1)}`);
  console.log(`timeout games:    ${timeoutGames} (auto-answered decisions: ${autoDecisions})`);

  console.log('\nwins by seat index (all player counts pooled):');
  const seats = [...winsBySeat.keys()].sort((a, b) => a - b);
  const totalWins = [...winsBySeat.values()].reduce((a, b) => a + b, 0);
  for (const seat of seats) {
    const n = winsBySeat.get(seat) ?? 0;
    const pct = ((n / totalWins) * 100).toFixed(1);
    console.log(`  seat ${seat}: ${String(n).padStart(5)}  ${pct.padStart(5)}%  ${'#'.repeat(Math.round(Number(pct) / 2))}`);
  }

  for (const f of failures.slice(0, 10)) {
    console.log(`\nFAIL seed=${f.seed} players=${f.playerCount}: ${f.error}`);
  }

  if (failures.length > 0 || replayMismatches > 0) process.exit(1);
}

const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1]?.endsWith('fuzz.js') === true;
if (invokedDirectly) fuzz(Number(process.argv[2] ?? 500), Number(process.argv[3] ?? 1));
