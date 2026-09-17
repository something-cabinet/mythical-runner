import type { RacerId } from '../ids.js';
import { SLICE_RACERS } from './defs/index.js';
import type { Hooks } from './hooks.js';
import type { RacerDef } from './types.js';

/**
 * The racer roster: all 36 racers from the rulebook, defined in `defs/index.ts`.
 *
 * Lookups are keyed by id and tolerate unknown ids — an unknown racer simply has no power
 * — which is what lets scenario tests field powerless stand-ins like `vanilla-01`.
 */
const ROSTER_SIZE = 36;

export const RACERS: readonly RacerDef[] = SLICE_RACERS;

if (RACERS.length !== ROSTER_SIZE) {
  throw new Error(`Expected ${ROSTER_SIZE} racers, found ${RACERS.length}`);
}

const BY_ID = new Map<RacerId, RacerDef>(RACERS.map((r) => [r.id, r]));

/** Shared empty hook set, so powerless racers cost nothing to dispatch. */
const NO_HOOKS: Hooks = Object.freeze({});

export function getRacer(id: RacerId): RacerDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown racer '${id}'`);
  return def;
}

/**
 * The hooks printed on a racer's card, or an empty set.
 *
 * The engine dispatches through `hooksFor` in `powers.ts` instead, because the power a
 * racer *has* isn't always the one on its card. Hot path — called per movement step.
 */
export function getHooks(id: RacerId): Hooks {
  return (BY_ID.get(id)?.hooks as Hooks | undefined) ?? NO_HOOKS;
}

export function racerName(id: RacerId): string {
  return BY_ID.get(id)?.name ?? String(id);
}

export function racerText(id: RacerId): string {
  return BY_ID.get(id)?.text ?? '';
}

export const ALL_RACER_IDS: readonly RacerId[] = RACERS.map((r) => r.id);

/** Racers with at least one hook. Used by tests and by the fuzzer's reporting. */
export const RACERS_WITH_ABILITIES: readonly RacerId[] = RACERS.filter(
  (r) => r.hooks !== undefined,
).map((r) => r.id);
