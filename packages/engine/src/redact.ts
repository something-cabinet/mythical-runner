import type { PlayerId, RacerId } from './ids.js';
import { racersPerRace, type GameState, type PlayerView, type RedactedPhase } from './state.js';

/**
 * Produces the view one player is allowed to see.
 *
 * Several things are removed, each for a different reason:
 *
 *  1. `seed` — a client holding it could precompute every future die roll.
 *  2. other players' commits during the commit phase — the game's only hidden
 *     information, and the whole point of simultaneous selection.
 *  3. `pending.resume` — handler continuation context, which is engine internals and
 *     could leak the shape of an ability's resolution before it happens.
 *  4. `queue` and `turnStartPos` — the engine's working memory for a turn in progress.
 *
 * This is the only function permitted to build a payload bound for a client. Everything
 * else broadcasts its output. The `PlayerView` type enforces the omissions structurally,
 * so forgetting one is a compile error rather than a silent leak.
 */
export function redact(state: GameState, viewer: PlayerId): PlayerView {
  const { seed: _seed, queue: _queue, turnStartPos: _turnStartPos, phase, pending, ...rest } = state;
  void _seed;
  void _queue;
  void _turnStartPos;

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

  const entries = Object.entries(phase.committed) as [PlayerId, readonly RacerId[]][];
  const need = racersPerRace(entries.length);
  return {
    t: 'commit',
    raceNo: phase.raceNo,
    yourCommit: phase.committed[viewer] ?? [],
    committedBy: entries.filter(([, r]) => r.length >= need).map(([p]) => p),
  };
}
