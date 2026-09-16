import { mildMile } from './mildMile.js';
import { wildWilds } from './wildWilds.js';
import type { Track, TrackId } from './types.js';

export * from './types.js';
export { mildMile } from './mildMile.js';
export { wildWilds } from './wildWilds.js';

export const TRACKS: Readonly<Record<TrackId, Track>> = {
  mildMile,
  wildWilds,
};

/**
 * Which side of the board each race runs on.
 *
 * The board is flipped between races: races 1 and 3 are plain, races 2 and 4 are wild.
 */
export type RaceNumber = 1 | 2 | 3 | 4;

export const RACE_TRACKS: Readonly<Record<RaceNumber, TrackId>> = {
  1: 'mildMile',
  2: 'wildWilds',
  3: 'mildMile',
  4: 'wildWilds',
};

export function trackForRace(raceNo: RaceNumber): Track {
  return TRACKS[RACE_TRACKS[raceNo]];
}
