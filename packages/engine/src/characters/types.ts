import type { RacerId } from '../ids.js';

/**
 * A racer definition.
 *
 * Phase 1 ships only the metadata half. The `hooks` field arrives in phase 2 along with
 * the ability pipeline; it is declared here as an optional opaque record so that adding
 * abilities does not change this type's shape or break the registry.
 */
export interface RacerDef {
  readonly id: RacerId;
  readonly name: string;
  /** Rules text, shown in the UI. Empty for vanilla placeholders. */
  readonly text: string;
  /**
   * Populated in phase 2. Kept `unknown` for now rather than `any` so that any premature
   * use is a compile error rather than a silent no-op.
   */
  readonly hooks?: Readonly<Record<string, unknown>>;
}
