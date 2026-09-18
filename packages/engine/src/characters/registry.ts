import type { RacerId } from '../ids.js';
import { CLASSIC_RACERS } from './defs/classic.js';
import { DOTA_RACERS } from './defs/dota.js';
import type { Hooks } from './hooks.js';
import { CHARACTER_SETS, type CharacterSetId } from './sets.js';
import type { RacerDef } from './types.js';

/**
 * The racer roster: every racer in every set. The classic 36 are in `defs/classic.ts`,
 * the Dota heroes in `defs/dota.ts`.
 *
 * Lookups are keyed by id and tolerate unknown ids — an unknown racer simply has no power
 * — which is what lets scenario tests field powerless stand-ins like `vanilla-01`.
 */
export const RACERS: readonly RacerDef[] = [...CLASSIC_RACERS, ...DOTA_RACERS];

const SET_SIZES: Readonly<Record<CharacterSetId, number>> = { classic: 36, dota: 22 };

for (const set of CHARACTER_SETS) {
  const found = RACERS.filter((r) => r.set === set.id).length;
  if (found !== SET_SIZES[set.id]) {
    throw new Error(`Expected ${SET_SIZES[set.id]} racers in set '${set.id}', found ${found}`);
  }
}
if (new Set(RACERS.map((r) => r.id)).size !== RACERS.length) {
  throw new Error('Two racers share an id');
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

/**
 * A racer's name as it should be shown in a game drawing on `sets`.
 *
 * Names are only unique within a set — the classic set and the Dota set both field an
 * Alchemist — so with more than one set in play every racer is qualified by its set,
 * "Genius (Classic)" alongside "Morphling (Dota)". With a single set there is nothing to
 * tell apart, and the bare name reads better.
 *
 * Stand-ins like `vanilla-01` belong to no set and are never qualified.
 */
export function racerLabel(id: RacerId, sets: readonly CharacterSetId[]): string {
  const name = racerName(id);
  if (sets.length < 2) return name;
  const set = CHARACTER_SETS.find((s) => s.id === BY_ID.get(id)?.set);
  return set ? `${name} (${set.name})` : name;
}

export function racerText(id: RacerId): string {
  return BY_ID.get(id)?.text ?? '';
}

export const ALL_RACER_IDS: readonly RacerId[] = RACERS.map((r) => r.id);

/** Every racer in the given sets, in roster order: the draft deck before shuffling. */
export function racersInSets(sets: readonly CharacterSetId[]): RacerId[] {
  return RACERS.filter((r) => sets.includes(r.set)).map((r) => r.id);
}

/** The set a racer ships in, or undefined for a stand-in like `vanilla-01`. */
export function racerSet(id: RacerId): CharacterSetId | undefined {
  return BY_ID.get(id)?.set;
}

/** Racers with at least one hook. Used by tests and by the fuzzer's reporting. */
export const RACERS_WITH_ABILITIES: readonly RacerId[] = RACERS.filter(
  (r) => r.hooks !== undefined,
).map((r) => r.id);
