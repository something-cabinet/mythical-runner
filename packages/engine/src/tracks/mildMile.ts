import { assertValidTrack, plain, TRACK_LENGTH, type Track } from './types.js';

/**
 * The Mild Mile — the plain side of the board, used for races 1 and 3.
 *
 * Every space is inert. All the chaos on this side comes from racer abilities alone,
 * which is the point: it is the control against which the Wild Wilds is the variable.
 */
export const mildMile: Track = assertValidTrack({
  id: 'mildMile',
  name: 'Mild Mile',
  spaces: Array.from({ length: TRACK_LENGTH }, (_, i) => plain(i)),
  secondCorner: 15,
});
