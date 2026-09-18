import { racerId } from '../../ids.js';
import type { HookCtx, Hooks, MutableRacer } from '../hooks.js';
import type { CharacterSetId } from '../sets.js';
import type { RacerDef } from '../types.js';

/** A `def` bound to one set, so each set's file names its set once. */
export function defFor(set: CharacterSetId) {
  return (id: string, name: string, text: string, hooks: Hooks): RacerDef => ({
    id: racerId(id),
    set,
    name,
    text,
    hooks: hooks as unknown as Record<string, unknown>,
  });
}

export const isRunning = (r: MutableRacer): boolean => !r.eliminated && r.finishedRank === null;

/**
 * Rule 8: "If you run into an infinite loop, e.g. Scoocher stopping on the Huge Baby,
 * complete the loop once in the order it takes place, then end it."
 *
 * A loop is the same trigger firing again with every racer exactly where they were last
 * time. Returns false for such a repeat within the current turn, so a power that reacts
 * to its own consequences runs each lap once and then stops.
 *
 * The same turn, not the same action: a loop through Suckerfish asks a question on every
 * lap, and each answer is a new action.
 */
export function firstLap(h: HookCtx, trigger: string): boolean {
  const phase = h.state.phase;
  if (phase.t !== 'racing') return true;
  const board = h
    .racers()
    .map((r) => (r.eliminated ? 'x' : String(r.pos)))
    .join(',');
  const cause = `${trigger}|${board}`;
  const prior = h.self.memo['loopCauses'] as { turn: number; causes: string[] } | undefined;
  const seen = prior?.turn === phase.turn ? prior.causes : [];
  if (seen.includes(cause)) return false;
  h.self.memo['loopCauses'] = { turn: phase.turn, causes: [...seen, cause] };
  return true;
}
