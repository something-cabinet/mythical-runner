import { arrow, assertValidTrack, plain, star, trip, type Track } from './types.js';

/**
 * The Wild Wilds — the chaotic side of the board, used for races 2 and 4.
 *
 * ############################################################################
 * # PLACEHOLDER LAYOUT — NOT THE REAL BOARD                                  #
 * #                                                                          #
 * # The rulebook documents the three space types (arrow, TRIP, star) but     #
 * # does not print the board, so the arrangement below is invented to        #
 * # unblock the rest of the build. It is shaped to be plausible, not         #
 * # accurate.                                                                #
 * #                                                                          #
 * # Replace from the physical board. Nothing outside this file depends on    #
 * # the specific arrangement, so it is a one-file change.                    #
 * ############################################################################
 *
 * Space 0 is the Start space and is always plain.
 */
export const wildWilds: Track = assertValidTrack({
  id: 'wildWilds',
  name: 'Wild Wilds',
  spaces: [
    plain(0),
    plain(1),
    star(2),
    plain(3),
    arrow(4, 2),
    trip(5),
    plain(6),
    star(7),
    plain(8),
    arrow(9, -3),
    plain(10),
    star(11),
    arrow(12, 3),
    plain(13),
    trip(14),
    plain(15),
    star(16),
    arrow(17, -2),
    plain(18),
    arrow(19, 2),
    star(20),
    plain(21),
    trip(22),
    plain(23),
    arrow(24, 4),
    star(25),
    plain(26),
    arrow(27, -4),
    plain(28),
    star(29),
  ],
});
