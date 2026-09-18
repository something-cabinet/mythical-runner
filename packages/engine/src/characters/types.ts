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
  readonly hooks?: Readonly<Record<string, unknown>>;
}
