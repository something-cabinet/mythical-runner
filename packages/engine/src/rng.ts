/**
 * Deterministic, seeded randomness.
 *
 * The entire game is reproducible from `(seed, actions[])`. To make that work, the RNG
 * stream must be a pure function of the game's `step` counter rather than of hidden
 * mutable state — otherwise a Durable Object that hibernates mid-game would resume with
 * a different stream.
 *
 * So: every call to `makeRng(seed, step)` yields the same sequence. The engine bumps
 * `step` after each action and never reuses a step.
 *
 * The seed is server-only. It is never included in a redacted player view — a client
 * holding the seed could precompute every future roll.
 */

/** splitmix32 — used to mix (seed, step) into a well-distributed 32-bit state. */
function splitmix32(a: number): number {
  a = (a + 0x9e3779b9) | 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  return (t = t ^ (t >>> 15)) >>> 0;
}

export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** A single d6, 1..6. */
  rollD6(): number;
  /** Fisher-Yates shuffle; returns a new array, does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
  /** How many raw draws have been taken. Useful for assertions in replay tests. */
  readonly draws: number;
}

/**
 * Builds the RNG stream for a given (seed, step) pair.
 *
 * Both arguments are mixed, so consecutive steps produce unrelated streams rather than
 * adjacent slices of one stream.
 */
export function makeRng(seed: number, step: number): Rng {
  // Mix the two inputs so that step N and step N+1 are not correlated.
  let state = splitmix32(splitmix32(seed >>> 0) ^ splitmix32(step >>> 0));
  let draws = 0;

  const nextUint32 = (): number => {
    draws++;
    state = splitmix32(state);
    return state;
  };

  const rng: Rng = {
    nextInt(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`nextInt requires a positive integer bound, got ${maxExclusive}`);
      }
      // Rejection sampling, so the distribution stays uniform rather than
      // being skewed by the modulo bias. Matters for dice.
      const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
      let v = nextUint32();
      while (v >= limit) v = nextUint32();
      return v % maxExclusive;
    },

    nextFloat(): number {
      return nextUint32() / 0x100000000;
    },

    rollD6(): number {
      return rng.nextInt(6) + 1;
    },

    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.nextInt(i + 1);
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },

    get draws() {
      return draws;
    },
  };

  return rng;
}

/** Generates a fresh game seed. The only non-deterministic call in the engine. */
export function newSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}
