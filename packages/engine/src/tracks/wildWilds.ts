import { arrow, assertValidTrack, plain, star, trip, type Track } from './types.js';

/**
 * The Wild Wilds — the chaotic side of the board, used for races 2 and 4.
 *
 * Transcribed from a photo of the printed board. The track runs Start → 1–12 along the
 * top, 13–14 down the far side, and 15–29 back along the bottom toward the finish. Arrows
 * are read against that direction of travel: on the bottom row, an arrow pointing away
 * from the finish (toward space 15) sends a racer back.
 *
 * Space 0 is the Start space and is always plain.
 */
export const wildWilds: Track = assertValidTrack({
  id: 'wildWilds',
  name: 'Wild Wilds',
  spaces: [
    plain(0),
    star(1),
    plain(2),
    plain(3),
    plain(4),
    trip(5),
    plain(6),
    arrow(7, 3),
    plain(8),
    plain(9),
    plain(10),
    arrow(11, 1),
    plain(12),
    star(13),
    plain(14),
    plain(15),
    arrow(16, -4),
    trip(17),
    plain(18),
    plain(19),
    plain(20),
    plain(21),
    plain(22),
    arrow(23, 2),
    arrow(24, -2),
    plain(25),
    trip(26),
    plain(27),
    plain(28),
    plain(29),
  ],
  secondCorner: 15,
});
