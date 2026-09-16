/**
 * Branded identifier types.
 *
 * These are structurally strings at runtime, but the brand stops a PlayerId being
 * passed where a RacerId is expected — a mistake that is otherwise very easy to make
 * once abilities start targeting things.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Stable per-player identifier. Generated client-side, stored in localStorage. */
export type PlayerId = Brand<string, 'PlayerId'>;

/** Identifies a character/racer definition, e.g. 'banana'. */
export type RacerId = Brand<string, 'RacerId'>;

/** 4-character room join code, e.g. 'K3PQ'. */
export type RoomCode = Brand<string, 'RoomCode'>;

/**
 * Identifies one option within a PendingDecision. Opaque to the client — it simply
 * echoes back the id it was offered.
 */
export type ChoiceId = Brand<string, 'ChoiceId'>;

export const playerId = (s: string): PlayerId => s as PlayerId;
export const racerId = (s: string): RacerId => s as RacerId;
export const roomCode = (s: string): RoomCode => s as RoomCode;
export const choiceId = (s: string): ChoiceId => s as ChoiceId;
