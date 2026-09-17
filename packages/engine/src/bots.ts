import type { Action } from './actions.js';
import { legalActions } from './reducer/index.js';
import { makeRng } from './rng.js';
import type { GameState } from './state.js';

/**
 * Fill bots.
 *
 * A bot is a seat the server plays. It chooses among exactly the legal actions a human in
 * that seat would be offered, so it can never do anything a player couldn't, and the
 * engine needs no bot-specific rules.
 *
 * Play is random, which is enough to keep a short-handed table moving. Two things are off
 * limits: lobby actions, and dismissing the scoreboard — humans should get to read the
 * results before the next race starts.
 *
 * Deterministic from the state, so a given position always gets the same bot move. The
 * stream is salted so bot choices don't correlate with the dice rolled at that step.
 */
const BOT_SALT = 0x5b07;

/** The next move any bot wants to make, or null if no bot has anything to do. */
export function botAction(state: GameState): Action | null {
  if (state.phase.t === 'lobby' || state.phase.t === 'scored' || state.phase.t === 'gameOver') {
    return null;
  }

  for (const player of state.players) {
    if (!player.bot) continue;
    const options = legalActions(state, player.id);
    if (options.length === 0) continue;
    const rng = makeRng(state.seed ^ BOT_SALT, state.step);
    return options[rng.nextInt(options.length)] ?? null;
  }
  return null;
}
