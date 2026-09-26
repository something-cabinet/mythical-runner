import type { RacerId } from '../ids.js';
import type { CharacterSetId } from './sets.js';

/**
 * A racer definition.
 *
 * `hooks` is declared as an opaque record so that this type — which the client imports —
 * doesn't drag the whole hook vocabulary along with it. The registry casts it back.
 */
export interface RacerDef {
  readonly id: RacerId;
  /** Which set this racer ships in. The host chooses which sets go into the draft. */
  readonly set: CharacterSetId;
  readonly name: string;
  /** Rules text, shown in the UI. Empty for vanilla placeholders. */
  readonly text: string;
  /**
   * The width of the "near me" window a positional power reads or acts on — 3 for "my
   * space or next to it", 5 for "within 2 spaces of me" — so the UI can glow those spaces
   * on the board. Undefined for racers with no such power.
   */
  readonly range?: 3 | 5;
  /**
   * Meepo: the other pieces that enter the race alongside this racer. Each is a racer of
   * its own on the board, with the same owner; the card drafted and committed is this one.
   */
  readonly squad?: readonly RacerId[];
  /** A piece of another racer's squad (see `squad`). Never drafted or dealt on its own. */
  readonly pieceOf?: RacerId;
  readonly hooks?: Readonly<Record<string, unknown>>;
}
