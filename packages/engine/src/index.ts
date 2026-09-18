/**
 * @mr/engine — the whole game as a pure function.
 *
 * No I/O, no React, no network, no dependencies. The same module runs on the client for
 * prediction and inside the Durable Object as the authority.
 *
 * Phase 0 established the vocabulary: identifiers, deterministic randomness, track data,
 * scoring, state shape, and the action/event unions. Phase 1 adds the reducer itself —
 * draft, commit, turn loop, movement, finish detection and scoring, with no abilities.
 */

export * from './ids.js';
export * from './rng.js';
export * from './tracks/index.js';
export * from './scoring.js';
export * from './state.js';
export * from './actions.js';
export * from './events.js';
export * from './errors.js';
export * from './jobs.js';
export * from './characters/types.js';
export * from './characters/sets.js';
export type { Hooks, HookCtx, HookName, AskRequest, MutableRacer } from './characters/hooks.js';
export {
  RACERS,
  ALL_RACER_IDS,
  RACERS_WITH_ABILITIES,
  getRacer,
  getHooks,
  racerName,
  racerText,
  racersInSets,
  racerSet,
} from './characters/registry.js';
export { powerOf, copyTarget } from './characters/powers.js';
export { initGame, applyAction, legalActions, type ApplyResult } from './reducer/index.js';
export { currentDrafter } from './reducer/draft.js';
export { enoughRacers, hostOf } from './reducer/lobby.js';
export { redact } from './redact.js';
export { botAction } from './bots.js';
export * from './protocol.js';
