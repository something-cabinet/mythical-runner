import type { PlayerId, RacerId } from './ids.js';
import type { GameState, PlayerView, RedactedPhase } from './state.js';

/**
 * Produces the view one player is allowed to see.
 *
 * Three things are removed, each for a different reason:
 *
 *  1. `seed` — a client holding it could precompute every future die roll.
 *  2. other players' commits during the commit phase — the game's only hidden
 *     information, and the whole point of simultaneous selection.
 *  3. `pending.resume` — handler continuation context, which is engine internals and
 *     could leak the shape of an ability's resolution before it happens.
 *
 * This is the only function permitted to build a payload bound for a client. Everything
 * else broadcasts its output. The `PlayerView` type enforces the omissions structurally,
 * so forgetting one is a compile error rather than a silent leak.
 */
export function redact(state: GameState, viewer: PlayerId): PlayerView {
  const { seed: _seed, phase, pending, ...rest } = state;
  void _seed;

  return {
    ...rest,
    you: viewer,
    phase: redactPhase(phase, viewer),
    pending: pending ? stripResume(pending) : null,
  };
}

function stripResume(pending: NonNullable<GameState['pending']>): PlayerView['pending'] {
  const { resume: _resume, ...visible } = pending;
  void _resume;
  return visible;
}

function redactPhase(phase: GameState['phase'], viewer: PlayerId): RedactedPhase {
  if (phase.t !== 'commit') return phase;

  const entries = Object.entries(phase.committed) as [PlayerId, RacerId | null][];
  return {
    t: 'commit',
    raceNo: phase.raceNo,
    yourCommit: phase.committed[viewer] ?? null,
    committedBy: entries.filter(([, r]) => r !== null).map(([p]) => p),
  };
}
