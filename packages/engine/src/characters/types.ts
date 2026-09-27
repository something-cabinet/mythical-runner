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
  /**
   * Rules text, shown in the UI. Empty for vanilla placeholders. For a racer with a
   * `reference` card, the gist — the card holds the detail.
   */
  readonly text: string;
  /**
   * Detail too long to read at a glance — Invoker's ten spells — kept off the racer card
   * and shown on demand, as a reference card the player opens.
   */
  readonly reference?: ReferenceCard;
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

/** A racer's reference card: the detail behind its rules text, one entry per item. */
export interface ReferenceCard {
  /** Sets up the entries, e.g. how a spell is picked. */
  readonly intro?: string;
  readonly entries: readonly ReferenceEntry[];
}

export interface ReferenceEntry {
  readonly name: string;
  readonly text: string;
  /**
   * Colour chips shown before the name — Invoker's orbs. Names the client knows (`blue`,
   * `pink`, `orange`) get the game's own shades; anything else is used as a CSS colour.
   */
  readonly swatches?: readonly string[];
}
