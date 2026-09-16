import { racerId, type RacerId } from '../ids.js';
import type { RacerDef } from './types.js';

/**
 * The racer roster.
 *
 * ############################################################################
 * # PHASE 1: VANILLA PLACEHOLDERS                                            #
 * #                                                                          #
 * # Every racer here is mechanically identical — roll, move, nothing else.   #
 * # That is deliberate. Phase 1 proves the draft, commit, turn loop, finish  #
 * # detection and scoring work in isolation, with no ability interactions to #
 * # confound a failure.                                                      #
 * #                                                                          #
 * # Phase 2 replaces these with real definitions carrying `hooks`. Nothing   #
 * # outside this file knows how many racers exist or what they do, so that   #
 * # swap is contained.                                                       #
 * ############################################################################
 *
 * Count matches the real game (35), which matters for one reason: the draft deals
 * 4 x playerCount cards, so at 6 players it consumes 24. The roster must comfortably
 * exceed that or late drafts become forced.
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

export const RACERS: readonly RacerDef[] = Array.from({ length: ROSTER_SIZE }, (_, i) =>
  vanilla(i + 1),
);

const BY_ID = new Map<RacerId, RacerDef>(RACERS.map((r) => [r.id, r]));

export function getRacer(id: RacerId): RacerDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown racer '${id}'`);
  return def;
}

export function racerName(id: RacerId): string {
  return BY_ID.get(id)?.name ?? String(id);
}

export const ALL_RACER_IDS: readonly RacerId[] = RACERS.map((r) => r.id);
