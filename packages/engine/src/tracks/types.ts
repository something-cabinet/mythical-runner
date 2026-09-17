/**
 * Track geometry and space effects.
 *
 * Positions use a single integer axis shared by both tracks:
 *
 *   START = 0    the staging space — the rules are explicit that "the Start space counts
 *                as a space", so it is on the track, not off it
 *   1 .. 29      the remaining track spaces
 *   FINISH = 30  past the last space; a racer at FINISH has crossed the line
 *
 * "Anything past the finish line doesn't [count as a space]", so FINISH is a terminal
 * marker rather than a space with effects.
 */

export const START = 0;
export const TRACK_LENGTH = 30;
export const FINISH = TRACK_LENGTH;

export type SpaceEffect =
  /** Nothing happens. Every space on the Mild Mile. */
  | { readonly t: 'plain' }
  /**
   * "When you stop on a space with an arrow, move the number of spaces shown in the
   * arrow's direction. This counts as a separate move than how you got there, and never
   * part of your main move."
   *
   * `amount` is signed: negative points back toward Start.
   */
  | { readonly t: 'arrow'; readonly amount: number }
  /** "When you stop on a space that says TRIP, you trip!" */
  | { readonly t: 'trip' }
  /** "When you stop on a space with a star, take a bronze 1 point chip." */
  | { readonly t: 'star'; readonly value: number };

export interface Space {
  /** 0-based index along the track; index 0 is the Start space. */
  readonly index: number;
  readonly effect: SpaceEffect;
}

export type TrackId = 'mildMile' | 'wildWilds';

export interface Track {
  readonly id: TrackId;
  readonly name: string;
  /** Exactly TRACK_LENGTH entries, index i at position i. */
  readonly spaces: readonly Space[];
  /**
   * The index of the physical board's second corner, for Blimp's "before/on or after the
   * second corner". Both printed tracks turn their second corner at space 15.
   */
  readonly secondCorner: number;
}

export function plain(index: number): Space {
  return { index, effect: { t: 'plain' } };
}

/** Positive is toward the finish, negative is back toward Start. */
export function arrow(index: number, amount: number): Space {
  return { index, effect: { t: 'arrow', amount } };
}

export function trip(index: number): Space {
  return { index, effect: { t: 'trip' } };
}

export function star(index: number, value = 1): Space {
  return { index, effect: { t: 'star', value } };
}

/** Throws if a track is malformed. Called at module load for each track. */
export function assertValidTrack(track: Track): Track {
  if (track.spaces.length !== TRACK_LENGTH) {
    throw new Error(
      `Track '${track.id}' has ${track.spaces.length} spaces, expected ${TRACK_LENGTH}`,
    );
  }
  track.spaces.forEach((space, i) => {
    if (space.index !== i) {
      throw new Error(`Track '${track.id}' space at position ${i} declares index ${space.index}`);
    }
    if (space.effect.t === 'arrow' && space.effect.amount === 0) {
      throw new Error(`Track '${track.id}' space ${i} has a zero-length arrow`);
    }
    if (i === 0 && space.effect.t !== 'plain') {
      throw new Error(`Track '${track.id}' gives the Start space an effect`);
    }
  });
  return track;
}
