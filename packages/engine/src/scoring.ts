import type { RaceNumber } from './tracks/index.js';

/**
 * Point chips.
 *
 * The physical game ships 9 bronze 3-point chips and 16 bronze 1-point chips, but those
 * are just denominations — a 3-point chip is change for three 1-point chips, handed out so
 * the bank doesn't run dry. Nothing in the rules awards "a 3-point chip" as a distinct
 * reward. Digitally that distinction is meaningless, so a chip is simply a number and
 * there is no supply to exhaust.
 */
export type TokenKind = 'gold' | 'silver' | 'points';

export interface Token {
  readonly kind: TokenKind;
  readonly value: number;
  /** Which race it came from, for display and replay readability. */
  readonly raceNo: RaceNumber;
}

/**
 * Cup values per race, confirmed against the physical components.
 *
 * First place takes the gold cup, second the silver. Both escalate, so a late win is worth
 * materially more than an early one — which is why holding a strong racer back is a real
 * decision.
 */
export const RACE_AWARDS: Readonly<Record<RaceNumber, { gold: number; silver: number }>> = {
  1: { gold: 3, silver: 1 },
  2: { gold: 4, silver: 2 },
  3: { gold: 4, silver: 2 },
  4: { gold: 5, silver: 3 },
};

export function goldToken(raceNo: RaceNumber): Token {
  return { kind: 'gold', value: RACE_AWARDS[raceNo].gold, raceNo };
}

export function silverToken(raceNo: RaceNumber): Token {
  return { kind: 'silver', value: RACE_AWARDS[raceNo].silver, raceNo };
}

/** A bronze chip award, from a star space or a racer power. */
export function pointsToken(value: number, raceNo: RaceNumber): Token {
  return { kind: 'points', value, raceNo };
}

export function totalPoints(tokens: readonly Token[]): number {
  return tokens.reduce((sum, t) => sum + t.value, 0);
}
