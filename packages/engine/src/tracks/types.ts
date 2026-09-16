/**
 * Track geometry and space effects.
 *
 * Positions use a single integer axis shared by both tracks:
 *
 *   START = -1   the staging space every racer begins on
 *   0 .. 29      the 30 track spaces
 *   FINISH = 30  past the last space; a racer at FINISH has crossed the line
 *
 * Keeping START off-board as -1 (rather than as space 0) means "move N spaces" is
 * always plain addition, including on the very first turn.
 */

export const START = -1;
export const TRACK_LENGTH = 30;
export const FINISH = TRACK_LENGTH;

export type SpaceEffect =
  /** Nothing happens. Every space on the Mild Mile. */
  | { readonly t: 'plain' }
  /** Racer is pushed forward on landing. Does not re-trigger chained effects. */
  | { readonly t: 'forward'; readonly amount: number }
  /** Racer is pushed backward on landing. Cannot go below START. */
  | { readonly t: 'back'; readonly amount: number }
  /** Racer claims a point token on landing, if any remain in that space's supply. */
  | { readonly t: 'star'; readonly value: 1 | 3 };

export interface Space {
  /** 0-based index along the track. */
  readonly index: number;
  readonly effect: SpaceEffect;
}

export type TrackId = 'mildMile' | 'wildWilds';

export interface Track {
  readonly id: TrackId;
  readonly name: string;
  /** Exactly TRACK_LENGTH entries, index i at position i. */
  readonly spaces: readonly Space[];
}

/** Convenience for building space arrays. */
export function plain(index: number): Space {
  return { index, effect: { t: 'plain' } };
}

export function forward(index: number, amount: number): Space {
  return { index, effect: { t: 'forward', amount } };
}

export function back(index: number, amount: number): Space {
  return { index, effect: { t: 'back', amount } };
}

export function star(index: number, value: 1 | 3): Space {
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
    const { effect } = space;
    if ((effect.t === 'forward' || effect.t === 'back') && effect.amount <= 0) {
      throw new Error(`Track '${track.id}' space ${i} has non-positive amount ${effect.amount}`);
    }
  });
  return track;
}
