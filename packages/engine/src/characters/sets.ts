/**
 * Character sets: the boxes racers come in.
 *
 * The host picks any non-empty mix of sets in the lobby, and the draft deck is built from
 * every racer in the chosen sets. Adding a set means adding it here and giving its racers
 * that `set` in their definitions — nothing else in the engine names a set.
 */
export const CHARACTER_SETS = [
  { id: 'classic', name: 'Classic', text: 'The 36 racers from the Magical Athlete box.' },
  { id: 'dota', name: 'Dota', text: '22 heroes from Dota 2.' },
] as const;

export type CharacterSetId = (typeof CHARACTER_SETS)[number]['id'];

export const DEFAULT_SETS: readonly CharacterSetId[] = ['classic'];

export function isCharacterSetId(x: unknown): x is CharacterSetId {
  return CHARACTER_SETS.some((s) => s.id === x);
}
