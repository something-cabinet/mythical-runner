import type { Action, SystemTimeout } from '../actions.js';
import { IllegalActionError, invariant } from '../errors.js';
import type { PlayerId } from '../ids.js';
import { makeRng, type Rng } from '../rng.js';
import { STAR_SUPPLY } from '../scoring.js';
import type { GameEvent } from '../events.js';
import type { GameState } from '../state.js';
import { currentDrafter, draftPick, draftRoll } from './draft.js';
import { join, leave, setConnected, start } from './lobby.js';
import { beginCommit as _beginCommit, raceCommit } from './commit.js';
import { advanceAfterScoring, raceContinue, raceRoll, takeTurn } from './racing.js';
import { finish, hand, makeCtx, used, type Ctx } from './working.js';

export interface ApplyResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** A fresh, empty room. Players join via `lobby/join`. */
export function initGame(seed: number): GameState {
  return {
    seed,
    step: 0,
    players: [],
    seatOrder: [],
    hands: {},
    used: {},
    scores: {},
    starSupply: { ...STAR_SUPPLY },
    phase: { t: 'lobby' },
    board: [],
    pending: null,
    deadline: null,
  };
}

/**
 * The reducer. The only function that may produce a new GameState.
 *
 * Pure: the randomness comes from `makeRng(state.seed, state.step)`, so the same
 * `(state, action)` always yields the same result — on the server, on a client predicting
 * locally, and on a Durable Object resuming after hibernation.
 *
 * Deliberately deviates from the plan's sketched `applyAction(state, action, rng)`: the
 * caller cannot be trusted to advance the RNG stream in lockstep with `step`, and getting
 * it wrong would desync a replay in a way that is very hard to debug. Deriving it
 * internally makes that mistake unrepresentable.
 *
 * Throws `IllegalActionError` without mutating anything — application is all-or-nothing.
 */
export function applyAction(state: GameState, action: Action): ApplyResult {
  const ctx = makeCtx(state);
  const rng = makeRng(state.seed, state.step);

  route(ctx, action, rng);

  return { state: finish(ctx), events: ctx.events };
}

function route(ctx: Ctx, action: Action, rng: Rng): void {
  switch (action.t) {
    case 'lobby/join':
      return join(ctx, action);
    case 'lobby/leave':
      return leave(ctx, action);
    case 'lobby/setConnected':
      return setConnected(ctx, action);
    case 'lobby/start':
      return start(ctx, action);
    case 'draft/roll':
      return draftRoll(ctx, action, rng);
    case 'draft/pick':
      return draftPick(ctx, action);
    case 'race/commit':
      return raceCommit(ctx, action, rng);
    case 'race/roll':
      return raceRoll(ctx, action, rng);
    case 'race/decide':
      // Phase 2 introduces PendingDecision; until then nothing can be pending.
      throw new IllegalActionError(action, 'no decision is pending');
    case 'race/continue':
      return raceContinue(ctx, action);
    case 'system/timeout':
      return timeout(ctx, action, rng);
  }
}

/**
 * Turn-timer expiry.
 *
 * Re-validates the deadline against state rather than trusting the caller, so this stays
 * safe even on the Vercel design where any client may trigger it.
 */
function timeout(ctx: Ctx, a: SystemTimeout, rng: Rng): void {
  const { s } = ctx;
  if (s.deadline !== null && a.at < s.deadline) {
    throw new IllegalActionError(a, 'deadline has not passed');
  }

  switch (s.phase.t) {
    case 'draftRoll': {
      // Roll for everyone still outstanding.
      for (const [p, v] of Object.entries(s.phase.rolls) as [PlayerId, number | null][]) {
        if (v === null && s.phase.t === 'draftRoll') {
          draftRoll(ctx, { t: 'draft/roll', by: p }, rng);
        }
      }
      return;
    }
    case 'draft': {
      const who = currentDrafter(s.phase.order, s.phase.pick);
      const pick = s.phase.layout[0];
      invariant(pick, 'draft layout empty at timeout');
      return draftPick(ctx, { t: 'draft/pick', by: who, racerId: pick });
    }
    case 'commit': {
      for (const p of [...s.seatOrder]) {
        if (s.phase.t !== 'commit' || s.phase.committed[p] !== null) continue;
        const choice = hand(s, p).find((r) => !used(s, p).includes(r));
        invariant(choice, `player ${p} has no unused racer at timeout`);
        raceCommit(ctx, { t: 'race/commit', by: p, racerId: choice }, rng);
      }
      return;
    }
    case 'racing':
      return takeTurn(ctx, rng);
    case 'scored':
      return advanceAfterScoring(ctx);
    case 'lobby':
    case 'gameOver':
      return;
  }
}

/**
 * Every action `player` could legally take right now.
 *
 * The server uses this to validate inbound messages; the client uses it to decide what to
 * enable. Both consulting one implementation is the point — a button that is enabled but
 * rejected, or disabled but allowed, is a class of bug that cannot occur this way.
 */
export function legalActions(state: GameState, player: PlayerId): Action[] {
  const s = state;

  if (s.pending) {
    if (s.pending.player !== player) return [];
    return s.pending.options.map((o) => ({ t: 'race/decide', by: player, choice: o.id }));
  }

  switch (s.phase.t) {
    case 'lobby': {
      const joined = s.players.some((p) => p.id === player);
      if (!joined) return [{ t: 'lobby/join', by: player, name: '' }];
      const out: Action[] = [{ t: 'lobby/leave', by: player }];
      if (s.players[0]?.id === player && s.players.length >= 2) {
        out.push({ t: 'lobby/start', by: player });
      }
      return out;
    }
    case 'draftRoll':
      return s.phase.rolls[player] === null ? [{ t: 'draft/roll', by: player }] : [];

    case 'draft': {
      if (currentDrafter(s.phase.order, s.phase.pick) !== player) return [];
      return s.phase.layout.map((racerId) => ({ t: 'draft/pick', by: player, racerId }));
    }
    case 'commit': {
      if (s.phase.committed[player] !== undefined && s.phase.committed[player] !== null) return [];
      const owned = s.hands[player] ?? [];
      const spent = s.used[player] ?? [];
      return owned
        .filter((r) => !spent.includes(r))
        .map((racerId) => ({ t: 'race/commit', by: player, racerId }));
    }
    case 'racing':
      return s.phase.active === player ? [{ t: 'race/roll', by: player }] : [];

    case 'scored':
      return s.seatOrder.includes(player) ? [{ t: 'race/continue', by: player }] : [];

    case 'gameOver':
      return [];
  }
}
