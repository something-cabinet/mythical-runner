import { racerId, type RacerId } from '../ids.js';
import { SLICE_RACERS } from './defs/index.js';
import type { Hooks } from './hooks.js';
import type { RacerDef } from './types.js';

/**
 * The racer roster.
 *
 * Phase 2 status: seven racers are real (see `defs/index.ts`) and exercise every hook in
 * the pipeline. The rest are vanilla padding — roll, move, nothing else — so that a
 * 6-player draft, which consumes 24 cards, still has a full pool to deal from.
 *
 * Phase 5 replaces the padding with the remaining real racers. Nothing outside this file
 * knows which are which.
 */
const ROSTER_SIZE = 35;

function vanilla(n: number): RacerDef {
  const num = String(n).padStart(2, '0');
  return {
    id: racerId(`vanilla-${num}`),
    name: `Racer ${num}`,
    text: '',
  };
}

const PADDING_COUNT = ROSTER_SIZE - SLICE_RACERS.length;

export const RACERS: readonly RacerDef[] = [
  ...SLICE_RACERS,
  ...Array.from({ length: PADDING_COUNT }, (_, i) => vanilla(i + 1)),
];

const BY_ID = new Map<RacerId, RacerDef>(RACERS.map((r) => [r.id, r]));

/** Shared empty hook set, so vanilla racers cost nothing to dispatch. */
const NO_HOOKS: Hooks = Object.freeze({});

export function getRacer(id: RacerId): RacerDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown racer '${id}'`);
  return def;
}

/** The hooks for a racer, or an empty set. Hot path — called per movement step. */
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
