import { assertValidTrack, back, forward, plain, star, type Track } from './types.js';

/**
 * The Wild Wilds — the chaotic side of the board, used for races 2 and 4.
 *
 * ############################################################################
 * # PLACEHOLDER LAYOUT — NOT THE REAL BOARD                                  #
 * #                                                                          #
 * # The published reviews confirm this side has spaces that push racers      #
 * # forward or backward and spaces that award point tokens, but none of them #
 * # give the actual arrangement. The layout below is invented to unblock     #
 * # phases 1-4; it is shaped to be plausible, not accurate.                  #
 * #                                                                          #
 * # Replace from the physical board before phase 5. Nothing outside this     #
 * # file depends on the specific arrangement, so swapping it is a one-file   #
 * # change with no engine impact.                                            #
 * #                                                                          #
 * # Star budget is constrained by the real component list: 9x 3-point and    #
 * # 16x 1-point bronze stars across BOTH Wild Wilds races combined.          #
 * ############################################################################
 */
export const wildWilds: Track = assertValidTrack({
  id: 'wildWilds',
  name: 'Wild Wilds',
  spaces: [
    plain(0),
    star(1, 1),
    plain(2),
    forward(3, 2),
    plain(4),
    star(5, 1),
    back(6, 2),
    plain(7),
    star(8, 3),
    plain(9),
    forward(10, 3),
    plain(11),
    star(12, 1),
    back(13, 3),
    plain(14),
    star(15, 3),
    plain(16),
    forward(17, 2),
    star(18, 1),
    plain(19),
    back(20, 4),
    star(21, 1),
    plain(22),
    forward(23, 4),
    plain(24),
    star(25, 3),
    back(26, 2),
    plain(27),
    star(28, 1),
    plain(29),
  ],
});
