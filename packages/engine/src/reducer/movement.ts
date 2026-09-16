import { invariant } from '../errors.js';
import { racerName } from '../characters/registry.js';
import { starToken } from '../scoring.js';
import { FINISH, START, trackForRace, type RaceNumber } from '../tracks/index.js';
import type { RacerState } from '../state.js';
import { type Ctx, type DeepMutable, scoreOf } from './working.js';

type Racer = DeepMutable<RacerState>;

/**
 * Moves a racer, one space at a time.
 *
 * Stepping rather than jumping is not a stylistic choice — it is the single decision the
 * whole ability system rests on. Pass-over triggers (Banana tripping anyone who crosses
 * it, blockers halting movement) can only exist if intermediate spaces are visited, and
 * the client's animation queue renders one `racer/moved` event per hop. Forced movement
 * and backward movement use this same loop for exactly the same reason.
 *
 * Phase 2 adds the per-step hook dispatch inside the loop. Phase 1 deliberately leaves
 * that seam empty so the core is provably correct on its own.
 *
 * @param resolveLanding false when the move was itself caused by a space effect, which
 *        stops two arrows pointing at each other from looping forever.
 */
export function moveSteps(
  ctx: Ctx,
  racer: Racer,
  distance: number,
  reason: 'roll' | 'ability' | 'space',
  resolveLanding = true,
): void {
  if (distance === 0) return;
  const dir = Math.sign(distance);
  const steps = Math.abs(distance);

  for (let i = 0; i < steps; i++) {
    if (racer.pos === FINISH) break;

    // Crossing the line does not require an exact roll; overshooting finishes.
    const next = Math.min(FINISH, Math.max(START, racer.pos + dir));
    if (next === racer.pos) break; // clamped at START moving backward

    const from = racer.pos;
    racer.pos = next;
    ctx.emit({ t: 'racer/moved', racerId: racer.racerId, from, to: next, reason });

    // PHASE 2 SEAM: onPassOver / onEnterSpace hooks dispatch here, per step.

    if (racer.pos === FINISH) break;
  }

  if (resolveLanding) resolveLandingEffect(ctx, racer);
}

/**
 * Applies the effect of the space a racer came to rest on.
 *
 * Only reached on the Wild Wilds; every Mild Mile space is inert.
 */
function resolveLandingEffect(ctx: Ctx, racer: Racer): void {
  if (racer.pos < 0 || racer.pos >= FINISH) return;

  const phase = ctx.s.phase;
  invariant(phase.t === 'racing', 'landing effect resolved outside a race');

  const track = trackForRace(phase.raceNo as RaceNumber);
  const space = track.spaces[racer.pos];
  invariant(space, `no space at index ${racer.pos} on track ${track.id}`);

  switch (space.effect.t) {
    case 'plain':
      return;

    case 'forward':
      ctx.emit({
        t: 'ability/triggered',
        racerId: racer.racerId,
        hook: 'space',
        text: `${racerName(racer.racerId)} is swept ${space.effect.amount} forward!`,
      });
      moveSteps(ctx, racer, space.effect.amount, 'space', false);
      return;

    case 'back':
      ctx.emit({
        t: 'ability/triggered',
        racerId: racer.racerId,
        hook: 'space',
        text: `${racerName(racer.racerId)} is knocked ${space.effect.amount} back!`,
      });
      moveSteps(ctx, racer, -space.effect.amount, 'space', false);
      return;

    case 'star':
      claimStar(ctx, racer, space.effect.value);
      return;
  }
}

/**
 * Awards a star, if one is still there to take.
 *
 * Two independent guards, because they fail for different reasons: `claimedSpaces` stops
 * the same space being looted twice in one race (otherwise a racer bounced back and forth
 * across it would farm points indefinitely), and `starSupply` enforces the physical
 * component count shared across both Wild Wilds races.
 */
function claimStar(ctx: Ctx, racer: Racer, value: 1 | 3): void {
  const phase = ctx.s.phase;
  invariant(phase.t === 'racing', 'star claimed outside a race');

  if (phase.claimedSpaces.includes(racer.pos)) return;
  if (ctx.s.starSupply[value] <= 0) return;

  phase.claimedSpaces.push(racer.pos);
  ctx.s.starSupply[value] -= 1;

  const token = starToken(value, phase.raceNo as RaceNumber);
  scoreOf(ctx.s, racer.owner).push(token);
  ctx.emit({ t: 'token/awarded', player: racer.owner, token });
}
