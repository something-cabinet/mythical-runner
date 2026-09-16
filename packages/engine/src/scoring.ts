import type { RaceNumber } from './tracks/index.js';

/**
 * Point tokens.
 *
 * Component counts in the physical game: 4 gold cups (1st place), 4 silver cups
 * (2nd place), 9 three-point bronze stars, 16 one-point bronze stars.
 */
export type TokenKind = 'gold' | 'silver' | 'star';

export interface Token {
  readonly kind: TokenKind;
  readonly value: number;
  /** Which race it came from, for display and for replay readability. */
  readonly raceNo: RaceNumber;
}

/**
 * Trophy values per race. Confirmed against the physical components.
 *
 * First place takes the gold cup, second place the silver cup. Both escalate across the
 * four races, so a late win is worth materially more than an early one — which is the
 * whole reason holding a strong racer back is a real decision.
 */
export const RACE_AWARDS: Readonly<Record<RaceNumber, { gold: number; silver: number }>> = {
  1: { gold: 3, silver: 1 },
  2: { gold: 4, silver: 2 },
  3: { gold: 4, silver: 2 },
  4: { gold: 5, silver: 3 },
};

/** Total star supply across the whole game, shared by both Wild Wilds races. */
export const STAR_SUPPLY: Readonly<Record<1 | 3, number>> = {
  1: 16,
  3: 9,
};

export function goldToken(raceNo: RaceNumber): Token {
  return { kind: 'gold', value: RACE_AWARDS[raceNo].gold, raceNo };
}

export function silverToken(raceNo: RaceNumber): Token {
  return { kind: 'silver', value: RACE_AWARDS[raceNo].silver, raceNo };
}

export function starToken(value: 1 | 3, raceNo: RaceNumber): Token {
  return { kind: 'star', value, raceNo };
}

export function totalPoints(tokens: readonly Token[]): number {
  return tokens.reduce((sum, t) => sum + t.value, 0);
}
