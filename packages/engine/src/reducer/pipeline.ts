import { racerLabel, racersInSets } from '../characters/registry.js';
import type { AskRequest, HookCtx, MutableRacer } from '../characters/hooks.js';
import {
  BORROWED,
  copyTarget,
  hooksFor,
  isMimic,
  MAIN_MOVE_BONUS,
  powerOf,
  SILENCED,
  SKIP_MAIN,
} from '../characters/powers.js';
import { invariant } from '../errors.js';
import type { ChoiceId, PlayerId, RacerId } from '../ids.js';
import type { Job, MoveReason, ResumeDescriptor } from '../jobs.js';
import type { Rng } from '../rng.js';
import { pointsToken } from '../scoring.js';
import { FINISHERS_PER_RACE } from '../state.js';
import { FINISH, START, trackForRace, type RaceNumber } from '../tracks/index.js';
import { type Ctx, findRacer, scoreOf } from './working.js';

/**
 * Drains the job queue until it is empty or a power suspends.
 *
 * Jobs are **popped before they run**. A job that is not finished — a move with spaces
 * left, or one interrupted by a question — re-queues itself at the front. Peeking instead
 * would make a suspended job re-run the work that caused the suspension, which loops.
 */
export function runQueue(ctx: Ctx, rng: Rng): void {
  const { s } = ctx;
  let guard = 0;

  while (s.queue.length > 0 && s.pending === null) {
    invariant(guard++ < 20000, 'job queue did not converge — likely a power loop');
    const job = s.queue.shift();
    invariant(job, 'queue head vanished');
    runJob(ctx, job, rng);
  }
}

function runJob(ctx: Ctx, job: Job, rng: Rng): void {
  switch (job.t) {
    case 'raceStart':
      return doRaceStart(ctx, job, rng);
    case 'beforeMove':
      return fireSelf(ctx, rng, job.racer, 'beforeMainMove');
    case 'afterMainMove':
      return doAfterMainMove(ctx, job, rng);
    case 'mainMove':
      return doMainMove(ctx, job.racer, rng);
    case 'roll':
      return doRoll(ctx, job, rng);
    case 'move':
      return doMoveStep(ctx, job, rng);
    case 'passCheck':
      return doPassCheck(ctx, job, rng);
    case 'spaceEffect':
      return doSpaceEffect(ctx, job, rng);
    case 'stopHooks':
      return doStopHooks(ctx, job, rng);
    case 'turnEnd':
      return doTurnEnd(ctx, job, rng);
    case 'endTurn':
      // Owned by racing.ts, injected on Ctx to avoid a circular import.
      return ctx.onEndTurn(rng);
    case 'resume':
      return doResume(ctx, job, rng);
  }
}

// --- Helpers ----------------------------------------------------------------

/** Racers `racer` is currently behind, i.e. stopped closer to Start than they are. */
function behindOf(ctx: Ctx, racer: MutableRacer): RacerId[] {
  return ctx.s.board
    .filter((o) => o.racerId !== racer.racerId && !o.eliminated && o.pos > racer.pos)
    .map((o) => o.racerId);
}

/**
 * Queues a move. What is needed to judge passing is captured when its first step runs.
 *
 * Every move in the game goes through here, so the pass rule is applied uniformly whether
 * the movement came from a die, a power or an arrow.
 *
 * Never suspends, so any hook may call it.
 */
export function queueMove(
  ctx: Ctx,
  racer: MutableRacer,
  distance: number,
  reason: MoveReason,
  opts: { isMainMove?: boolean; resolveStop?: boolean; triggerSpace?: boolean; front?: boolean } = {},
): void {
  // "Moving 0 doesn't count as moving" — not even enough to trigger a pass check.
  if (distance === 0) return;

  // A forward move from the finish line goes nowhere and would loop any power that fires
  // onStop based on position — the clamped zero-distance move settles, re-fires the same
  // hook, and the condition is unchanged.
  if (racer.pos === FINISH && distance > 0) return;

  const job: Job = {
    t: 'move',
    racer: racer.racerId,
    remaining: Math.abs(distance),
    dir: distance < 0 ? -1 : 1,
    reason,
    origin: racer.pos,
    startBehind: behindOf(ctx, racer),
    isMainMove: opts.isMainMove ?? false,
    resolveStop: opts.resolveStop ?? true,
    triggerSpace: opts.triggerSpace ?? opts.resolveStop ?? true,
    started: null,
  };

  if (opts.front === false) ctx.s.queue.push(job);
  else ctx.s.queue.unshift(job);
}

/**
 * Suckerfish: "When a racer on my space moves, I can move to their new space." Fired once
 * per move, as its first step is about to run, for every racer sharing the mover's space.
 *
 * Deliberately not at queue time. Moves are queued from inside hooks that must not suspend
 * — Lackey moving from `onAnyMainMoveRolled`, Scoocher scooching off a `modifyMainMove`
 * log — and only a running job can suspend safely, by putting itself back.
 *
 * Returns false if a question is now pending; the caller re-queues the move.
 */
function announceMoveStart(
  ctx: Ctx,
  job: Extract<Job, { t: 'move' }>,
  racer: MutableRacer,
  rng: Rng,
): boolean {
  if (job.started === null) {
    job.started = [];
    job.origin = racer.pos;
    job.startBehind = behindOf(ctx, racer);
  }
  for (const other of ctx.s.board) {
    if (other.racerId === racer.racerId || other.eliminated || other.pos !== job.origin) continue;
    if (job.started.includes(other.racerId)) continue;
    job.started.push(other.racerId);
    hooksFor(ctx.s, other).onOtherMoveStart?.(
      makeHookCtx(ctx, rng, other),
      racer,
      job.remaining * job.dir,
      job.dir,
    );
    if (ctx.s.pending) return false;
  }
  return true;
}

// --- Jobs -------------------------------------------------------------------

/**
 * Fires "before my race" powers for everyone, in board order.
 *
 * A job rather than a loop, because Egg and Twin ask a question here. Keyed by racer and
 * power, so a racer that picks up a new power along the way gets that power's "before
 * race" effect too — and can't get the same one twice.
 */
function doRaceStart(ctx: Ctx, job: Extract<Job, { t: 'raceStart' }>, rng: Rng): void {
  const key = (r: MutableRacer): string => `${r.racerId}:${powerOf(r)}`;
  for (let guard = 0; ; guard++) {
    invariant(guard < 1000, 'race start did not settle');
    const next = ctx.s.board.find((r) => !r.eliminated && !job.done.includes(key(r)));
    if (!next) return;
    job.done.push(key(next));

    const fn = hooksFor(ctx.s, next).onRaceStart;
    if (!fn) continue;
    ctx.s.queue.unshift(job);
    fn(makeHookCtx(ctx, rng, next));
    if (ctx.s.pending || ctx.s.queue[0] !== job) return;
    ctx.s.queue.shift();
  }
}

function doMainMove(ctx: Ctx, racerId: RacerId, rng: Rng): void {
  const racer = findRacer(ctx.s, racerId);
  invariant(racer, `main move for missing racer ${racerId}`);
  if (racer.eliminated || racer.finishedRank !== null) return;

  // Given up for a power (Earthshaker, Anti-Mage). Ahead of the trip check: a racer that
  // trips after choosing to skip has skipped this main move, and the trip costs the next.
  if (racer.memo[SKIP_MAIN] === true) {
    delete racer.memo[SKIP_MAIN];
    return;
  }

  if (racer.tripped) {
    // "A tripped racer skips their next main move! You don't even roll your die, though
    // your powers can still trigger and you can still move in other ways."
    racer.tripped = false;
    ctx.emit({ t: 'racer/stoodUp', racerId });
    return;
  }

  const hooks = hooksFor(ctx.s, racer);
  const h = makeHookCtx(ctx, rng, racer);

  if (hooks.skipsMainMove?.(h) === true) return;

  const replaced = hooks.replaceMainMove?.(h) ?? null;
  const face = replaced ?? rollDieOf(ctx, rng, racer);
  // Announce the throw before anything reacts to it: Magician's reroll and Alchemist's
  // transmute both ask a question from here on, and the player should see the die they are
  // being asked about.
  if (replaced === null) ctx.emit({ t: 'dice/thrown', player: racer.owner, racerId, value: face });
  ctx.s.queue.unshift({
    t: 'roll',
    racer: racerId,
    value: face,
    die: replaced === null,
    stage: 'reroll',
    done: [],
    distance: null,
    cancelled: false,
    rerolls: 0,
    tags: [],
    modifiedBy: replaced === null ? null : racerId,
  });
}

/** Racers in power trigger order for `mover`'s roll: "current player → other players". */
function triggerOrder(ctx: Ctx, mover: MutableRacer): MutableRacer[] {
  return [mover, ...ctx.s.board.filter((r) => r.racerId !== mover.racerId)].filter(
    (r) => !r.eliminated,
  );
}

/**
 * Settles a main move roll, then queues the move.
 *
 * The job stays at the head of the queue while each hook runs, so it is its own
 * continuation: if a hook asks a question or queues work of its own — Dicemonger moving
 * "before they move", Sisyphus warping — this returns and picks up where it left off once
 * that work is done. `done` makes re-entering safe.
 */
function doRoll(ctx: Ctx, job: Extract<Job, { t: 'roll' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer || racer.eliminated || racer.finishedRank !== null) return;

  if (job.die) {
    for (let guard = 0; ; guard++) {
      invariant(guard < 1000, 'main move roll did not settle');
      const next = triggerOrder(ctx, racer).find((r) => !job.done.includes(r.racerId));
      if (!next) {
        if (job.stage === 'final') break;
        job.stage = 'final';
        job.done = [];
        continue;
      }
      job.done.push(next.racerId);

      const hooks = hooksFor(ctx.s, next);
      const fn = job.stage === 'reroll' ? hooks.onMainRoll : hooks.onMainRollFinal;
      if (!fn) continue;

      // A reroll inside `fn` resets `stage` and `done`, which the loop simply follows.
      ctx.s.queue.unshift(job);
      fn(makeHookCtx(ctx, rng, next), racer, job.value);
      if (ctx.s.pending || ctx.s.queue[0] !== job) return;
      ctx.s.queue.shift();
    }
  }

  let value = job.distance ?? job.value;
  let cancelled = job.cancelled;
  let modifiedBy: RacerId | undefined = job.modifiedBy ?? undefined;

  // Lackey, Inchworm and Skipper react to the die before any modifiers apply — and may
  // react by queueing their own move. Track the queue length so that reaction jobs
  // (unshifted here) end up ahead of the main move itself once it's queued below, matching
  // "before they move". Only a real roll counts: Legs jogging 5 did not roll anything.
  const beforeReactions = ctx.s.queue.length;
  if (job.die) {
    for (const other of ctx.s.board) {
      if (other.eliminated) continue;
      const fn = hooksFor(ctx.s, other).onAnyMainMoveRolled;
      if (!fn) continue;
      const override = fn(makeHookCtx(ctx, rng, other), racer, job.value);
      invariant(!ctx.s.pending, `${other.racerId} asked a question from onAnyMainMoveRolled`);
      if (typeof override === 'number' && !cancelled) {
        if (override === 0) cancelled = true;
        else value = override;
        modifiedBy ??= other.racerId;
      }
    }
  }
  const reactionJobs = ctx.s.queue.splice(0, ctx.s.queue.length - beforeReactions);

  if (cancelled) {
    // A skipped move is not a move of 0 that Coach could hustle back into a move of 1.
    value = 0;
  } else {
    // Legion Commander's duel prize: "+1 permanently to their main move". Not a power the
    // racer has, so it applies first and every power adjusts the total.
    const bonus = racer.memo[MAIN_MOVE_BONUS];
    if (typeof bonus === 'number' && bonus !== 0) {
      value += bonus;
      modifiedBy ??= racer.racerId;
    }
    // Every racer on the board may adjust the main move — Gunk goops opponents, Coach
    // hustles anyone sharing his space. Self applies last so its own bonus is not lost.
    // `modifiedBy` names whichever racer's hook actually changed the value, not the mover.
    const others = ctx.s.board.filter((r) => r.racerId !== racer.racerId);
    for (const other of [...others, racer]) {
      if (other.eliminated) continue;
      const fn = hooksFor(ctx.s, other).modifyMainMove;
      if (!fn) continue;
      const next = fn(makeHookCtx(ctx, rng, other), value, racer);
      invariant(!ctx.s.pending, `${other.racerId} asked a question from modifyMainMove`);
      if (next !== value) modifiedBy ??= other.racerId;
      value = next;
    }
  }

  // `job.value` is the face that came to rest — after any reroll, before any modifier — so
  // it is what the player physically saw. Report it alongside the adjusted move whenever a
  // power moved the number, so the board can show the die and the arithmetic separately.
  const natural = job.die && job.value !== value ? job.value : undefined;
  // A distance set by a power, or a cancellation, stands in place of the die rather than
  // shifting it: Alchemist's 1 does not become "1 + 3".
  const wasReplaced = job.distance !== null || cancelled;

  ctx.emit({
    t: 'dice/rolled',
    player: racer.owner,
    racerId: racer.racerId,
    value,
    ...(natural !== undefined ? { natural } : {}),
    ...(natural !== undefined && wasReplaced ? { replaced: true } : {}),
    ...(modifiedBy ? { modifiedBy } : {}),
  });

  if (!cancelled) {
    const from = racer.pos;
    queueMove(ctx, racer, value, 'main', { isMainMove: true });
    // "After my main move" waits behind the move, and so behind everything the move sets off
    // — passes, space effects and stop powers are all queued ahead of it as the move settles.
    // A move of 0 queues nothing, and a main move that went nowhere never happened.
    const head = ctx.s.queue[0];
    if (head?.t === 'move' && head.racer === racer.racerId) {
      ctx.s.queue.splice(1, 0, { t: 'afterMainMove', racer: racer.racerId, from });
    }
  }
  // Re-insert the reactions now, ahead of the main move job just queued.
  ctx.s.queue.unshift(...reactionJobs);
}

/** The roll currently being decided. At most one exists: a turn has one main move. */
function currentRoll(ctx: Ctx): Extract<Job, { t: 'roll' }> | undefined {
  return ctx.s.queue.find((j): j is Extract<Job, { t: 'roll' }> => j.t === 'roll');
}

/**
 * Advances a move by exactly one space.
 *
 * Stepping is kept for two reasons even though no trigger fires mid-move any more:
 * Leaptoad needs to inspect each space it crosses, and the client animates one hop per
 * `racer/moved` event.
 */
function doMoveStep(ctx: Ctx, job: Extract<Job, { t: 'move' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  invariant(racer, `move for missing racer ${job.racer}`);

  const settle = (): void => {
    // Order matters: passing is judged first, then the space's own effect, then the stop
    // hooks — matching the rulebook's racetrack → current player → other players ordering.
    const tail: Job[] = [];
    if (job.startBehind.length > 0) {
      tail.push({ t: 'passCheck', racer: job.racer, startBehind: job.startBehind, done: [] });
    }
    // A move that ends where it began never happened, so nothing stopped: no space
    // effect, no `onStop`, no `onOtherStops`. This is "moving 0 doesn't count as moving"
    // from `queueMove`, applied to the moves that are only voided once under way —
    // Stickler's overshoot block, a clamp at Start, or a Huge Baby bounce straight back.
    //
    // It is also what stops position-keyed powers looping. Re-firing `onStop` at an
    // unchanged position re-tests an unchanged condition, so Romantic pinned on the last
    // space by Stickler would swoon forever — re-collecting that space's star on every
    // pass — until the queue guard tripped.
    if (job.resolveStop && racer.pos !== job.origin) {
      if (job.triggerSpace) tail.push({ t: 'spaceEffect', racer: job.racer, pos: racer.pos });
      tail.push({ t: 'stopHooks', racer: job.racer, done: [], pos: racer.pos });
    }
    if (tail.length > 0) ctx.s.queue.unshift(...tail);
  };

  if (job.remaining <= 0 || racer.eliminated || racer.pos === FINISH) return settle();

  if (job.started === null || racer.pos === job.origin) {
    const len = ctx.s.queue.length;
    if (!announceMoveStart(ctx, job, racer, rng)) {
      ctx.s.queue.splice(ctx.s.queue.length - len, 0, job);
      return;
    }
    // Suckerfish latching on queues its own move ahead of this one; let it go first, as
    // it did when the question was answered.
    if (ctx.s.queue.length !== len) {
      ctx.s.queue.splice(ctx.s.queue.length - len, 0, job);
      return;
    }
  }

  // Stickler: "Other racers can only cross the finish line by moving the exact number of
  // spaces they need. If they overshoot, they don't move." Checked only at the very start
  // of the move — `origin` is unchanged from `queueMove` — since the whole move is voided,
  // not just the excess.
  if (job.dir === 1 && racer.pos === job.origin && racer.pos + job.remaining > FINISH) {
    const stickler = ctx.s.board.find(
      (o) =>
        o.racerId !== racer.racerId &&
        !o.eliminated &&
        hooksFor(ctx.s, o).blocksOvershoot?.(makeHookCtx(ctx, rng, o)) === true,
    );
    if (stickler) {
      job.remaining = 0;
      powerHappened(
        ctx,
        rng,
        stickler,
        'blocksOvershoot',
        `Actually… ${racerLabel(racer.racerId, ctx.s.racerSets)} would overshoot the finish, so they don't move.`,
      );
      return settle();
    }
  }

  let next = racer.pos + job.dir;
  if (next < START) {
    // Clamped at Start; the rest of the movement is simply lost.
    job.remaining = 0;
    return settle();
  }
  if (next > FINISH) {
    job.remaining = 0;
    return settle();
  }

  // Leaptoad: "While moving, I skip spaces with other racers on them." An occupied space
  // is passed over without counting against the move — even backwards.
  if (hooksFor(ctx.s, racer).skipsOccupiedSpaces?.(makeHookCtx(ctx, rng, racer)) === true) {
    while (
      next > START &&
      next < FINISH &&
      ctx.s.board.some((o) => o.racerId !== racer.racerId && !o.eliminated && o.pos === next)
    ) {
      // One happening per space jumped: "if they jumpfrog over 2 consecutive occupied
      // spaces, I move 1 twice."
      powerHappened(
        ctx,
        rng,
        racer,
        'skipsOccupiedSpaces',
        `${racerLabel(racer.racerId, ctx.s.racerSets)} jumpfrogs over space ${next}.`,
      );
      next += job.dir;
    }
    next = Math.max(START, Math.min(FINISH, next));
  }

  const from = racer.pos;
  racer.pos = next;
  job.remaining -= 1;
  ctx.emit({ t: 'racer/moved', racerId: racer.racerId, from, to: next, reason: job.reason });

  if (racer.pos === FINISH) {
    job.remaining = 0;
    return settle();
  }

  if (job.remaining > 0) {
    ctx.s.queue.unshift(job);
    return;
  }

  // The move is over. Huge Baby may bounce the racer off its space before it truly stops.
  applyDisplacement(ctx, racer, rng);
  settle();
}

/**
 * Huge Baby: "No one can ever be on my space, besides the Start. Whenever that would
 * happen, put the racer on the space behind me instead."
 *
 * Explicitly not a move — "it's like they just stopped on that space instead" — so it
 * emits no `racer/moved` and cannot trigger movement-based powers.
 */
function applyDisplacement(ctx: Ctx, racer: MutableRacer, rng: Rng): void {
  let guard = 0;
  for (;;) {
    invariant(guard++ < 64, 'displacement did not settle');
    if (racer.pos === START || racer.pos === FINISH) return;

    const blocker = ctx.s.board.find(
      (o) =>
        o.racerId !== racer.racerId &&
        !o.eliminated &&
        o.pos === racer.pos &&
        hooksFor(ctx.s, o).blocksSpace?.(makeHookCtx(ctx, rng, o), racer) === true,
    );
    if (!blocker) return;

    const to = Math.max(START, blocker.pos - 1);
    if (to === racer.pos) return;
    racer.pos = to;
    powerHappened(
      ctx,
      rng,
      blocker,
      'blocksSpace',
      `${racerLabel(racer.racerId, ctx.s.racerSets)} can't fit past ${racerLabel(blocker.racerId, ctx.s.racerSets)} and settles behind them.`,
    );
  }
}

/**
 * Resolves passing once a move is complete.
 *
 * "When a racer starts a move behind a racer and ends the same move ahead of them." Both
 * halves are compared against stopped positions, which is why this cannot be done step by
 * step — a racer crossed and then knocked back has not passed anyone.
 */
function doPassCheck(ctx: Ctx, job: Extract<Job, { t: 'passCheck' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer || racer.eliminated) return;

  for (const id of job.startBehind) {
    if (job.done.includes(id)) continue;
    const other = findRacer(ctx.s, id);
    if (!other || other.eliminated) continue;

    // Must now be strictly ahead. Sharing a space is "neither ahead nor behind".
    if (racer.pos <= other.pos) continue;

    job.done.push(id);

    ctx.emit({
      t: 'racer/passed',
      racerId: racer.racerId,
      passed: other.racerId,
    });

    hooksFor(ctx.s, racer).onPass?.(makeHookCtx(ctx, rng, racer), other);
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }

    hooksFor(ctx.s, other).onPassed?.(makeHookCtx(ctx, rng, other), racer);
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
  }
}

function doSpaceEffect(ctx: Ctx, job: Extract<Job, { t: 'spaceEffect' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer || racer.eliminated || job.pos === FINISH) return;

  const phase = ctx.s.phase;
  invariant(phase.t === 'racing', 'space effect resolved outside a race');

  // Techies' mines replace whatever the space was.
  if (phase.tripSpaces.includes(job.pos)) {
    tripRacer(ctx, rng, racer, null);
    return;
  }

  const track = trackForRace(phase.raceNo as RaceNumber);
  const space = track.spaces[job.pos];
  invariant(space, 'no space at ' + job.pos + ' on ' + track.id);

  switch (space.effect.t) {
    case 'plain':
      return;

    case 'arrow': {
      const amount = space.effect.amount;
      ctx.emit({
        t: 'ability/triggered',
        racerId: racer.racerId,
        hook: 'space',
        text:
          amount > 0
            ? `${racerLabel(racer.racerId, ctx.s.racerSets)} is swept ${amount} forward!`
            : `${racerLabel(racer.racerId, ctx.s.racerSets)} is knocked ${-amount} back!`,
      });
      // "A separate move than how you got there, and never part of your main move."
      // The racer really does come to rest where the arrow puts them — "racers are stopped
      // on a space after they've finished moving onto it" — so stop powers fire there.
      // What must not repeat is the space's own effect, or two arrows facing each other
      // would loop forever.
      queueMove(ctx, racer, amount, 'space', { triggerSpace: false });
      return;
    }

    case 'trip':
      tripRacer(ctx, rng, racer, null);
      return;

    case 'star': {
      if (phase.claimedSpaces.includes(racer.pos)) return;
      phase.claimedSpaces.push(racer.pos);
      const value = awardFor(ctx, rng, racer, space.effect.value, 'star');
      const token = pointsToken(value, phase.raceNo as RaceNumber);
      scoreOf(ctx.s, racer.owner).push(token);
      ctx.emit({ t: 'token/awarded', player: racer.owner, token });
      return;
    }
  }
}

/**
 * Fires stop hooks for a racer that has come to rest.
 *
 * `self` first, then everyone else in board order — the rulebook's current player then
 * other players, clockwise. `done` guards against re-firing after a suspension.
 *
 * The `pos` stored in the job captures where the racer came to rest (before any arrow or
 * displacement moved them further). It is applied temporarily during hook dispatch so
 * powers see the actual stopping space rather than a post-arrow position — otherwise
 * Romantic could loop between two arrow spaces forever.
 */
function doStopHooks(ctx: Ctx, job: Extract<Job, { t: 'stopHooks' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer || racer.eliminated) return;

  // Temporarily restore the stopping position so hooks see the space the racer actually
  // landed on, not a post-arrow position.
  const savedPos = racer.pos;
  racer.pos = job.pos;

  if (!job.done.includes(racer.racerId)) {
    job.done.push(racer.racerId);
    hooksFor(ctx.s, racer).onStop?.(makeHookCtx(ctx, rng, racer));
    racer.pos = savedPos;
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
    racer.pos = job.pos;
  }

  for (const other of ctx.s.board) {
    if (other.racerId === racer.racerId || other.eliminated) continue;
    if (job.done.includes(other.racerId)) continue;
    job.done.push(other.racerId);

    hooksFor(ctx.s, other).onOtherStops?.(makeHookCtx(ctx, rng, other), racer);
    racer.pos = savedPos;
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
    racer.pos = job.pos;
  }

  racer.pos = savedPos;
}

/**
 * Fires `onTurnEnd` for the racer whose turn it was, then `onOtherTurnEnd` for everyone
 * else — Heckler watches every turn, not just nearby ones, so this mirrors `doStopHooks`
 * rather than `fireSelf`.
 */
function doTurnEnd(ctx: Ctx, job: Extract<Job, { t: 'turnEnd' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer || racer.eliminated) return;

  if (!job.done.includes(racer.racerId)) {
    job.done.push(racer.racerId);
    hooksFor(ctx.s, racer).onTurnEnd?.(makeHookCtx(ctx, rng, racer));
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
  }

  const startPos = ctx.s.turnStartPos;
  for (const other of ctx.s.board) {
    if (other.racerId === racer.racerId || other.eliminated) continue;
    if (job.done.includes(other.racerId)) continue;
    job.done.push(other.racerId);

    hooksFor(ctx.s, other).onOtherTurnEnd?.(makeHookCtx(ctx, rng, other), racer, startPos);
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
  }
}

function doAfterMainMove(ctx: Ctx, job: Extract<Job, { t: 'afterMainMove' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer || racer.eliminated) return;
  hooksFor(ctx.s, racer).afterMainMove?.(makeHookCtx(ctx, rng, racer), job.from);
}

/**
 * Trips a racer, from a power (`by`) or a TRIP space (null). Every trip goes through here,
 * so Templar Assassin can refuse one and Tidehunter and Oracle hear about each.
 *
 * Returns whether the racer actually went down.
 */
function tripRacer(ctx: Ctx, rng: Rng, target: MutableRacer, by: RacerId | null): boolean {
  if (target.tripped || target.eliminated) return false;
  if (hooksFor(ctx.s, target).ignoresTrip?.(makeHookCtx(ctx, rng, target)) === true) return false;

  target.tripped = true;
  ctx.emit({ t: 'racer/tripped', racerId: target.racerId, by });

  for (const r of [target, ...ctx.s.board.filter((o) => o.racerId !== target.racerId)]) {
    if (r.eliminated) continue;
    hooksFor(ctx.s, r).onRacerTripped?.(makeHookCtx(ctx, rng, r), target);
    invariant(!ctx.s.pending, `${r.racerId} asked a question from onRacerTripped`);
  }
  return true;
}

/**
 * Puts a racer on a space without moving it there: "don't count it as moving for
 * triggering powers, passing racers, etc."
 *
 * A warp skips the journey, not the arrival. "Racers are stopped on a space after they've
 * finished moving onto it, or otherwise arriving there by other means, like through Flip
 * Flop's warping power" — so the space they land on pays out, trips them or knocks them on
 * exactly as it would had they walked there, and stop powers fire.
 *
 * `resolveStop` is false only where the arrival is not a stop at all, and `triggerSpace`
 * false where the racer has stopped but the space must not fire again — a warp standing in
 * for an arrow's knock, just as the arrow's own move does not re-trigger.
 */
function warpRacer(
  ctx: Ctx,
  target: MutableRacer,
  pos: number,
  resolveStop = true,
  triggerSpace = true,
): void {
  const to = Math.max(START, Math.min(FINISH, pos));
  if (to === target.pos) return;
  target.pos = to;
  ctx.emit({ t: 'racer/warped', racerId: target.racerId, to });
  if (!resolveStop) return;
  // Unshifted together so the space resolves before the stop hooks, matching the order a
  // walked move settles in: racetrack, then current player, then other players.
  const tail: Job[] = [];
  if (triggerSpace) tail.push({ t: 'spaceEffect', racer: target.racerId, pos: target.pos });
  tail.push({ t: 'stopHooks', racer: target.racerId, done: [], pos: target.pos });
  ctx.s.queue.unshift(...tail);
}

/** Rolls `racer`'s own die: a d6, unless a power (Chaos Knight, Ogre Magi) says otherwise. */
function rollDieOf(ctx: Ctx, rng: Rng, racer: MutableRacer): number {
  const hooks = hooksFor(ctx.s, racer);
  const h = makeHookCtx(ctx, rng, racer);
  if (hooks.throwDie) return hooks.throwDie(h);
  return rng.roll(hooks.dieSides?.(h) ?? 6);
}

/**
 * A cup or star chip's value once the earner's powers have had their say — Dota's
 * Alchemist doubles both.
 */
export function awardFor(
  ctx: Ctx,
  rng: Rng,
  earner: MutableRacer,
  value: number,
  source: 'cup' | 'star',
): number {
  const fn = hooksFor(ctx.s, earner).modifyAward;
  if (!fn) return value;
  const next = fn(makeHookCtx(ctx, rng, earner), value, source);
  invariant(!ctx.s.pending, `${earner.racerId} asked a question from modifyAward`);
  return next;
}

function doResume(ctx: Ctx, job: Extract<Job, { t: 'resume' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer) return; // the power's owner left the board while we waited

  const hooks = hooksFor(ctx.s, racer, job.copy);
  invariant(hooks.resume, `${job.racer} suspended but defines no resume handler`);
  hooks.resume(makeHookCtx(ctx, rng, racer), job.key, job.choice, job.data);
}

// --- Hook dispatch ----------------------------------------------------------

function fireSelf(ctx: Ctx, rng: Rng, racerId: RacerId, name: 'beforeMainMove'): void {
  const racer = findRacer(ctx.s, racerId);
  if (!racer || racer.eliminated) return;
  const fn = hooksFor(ctx.s, racer)[name] as ((h: HookCtx) => void) | undefined;
  fn?.(makeHookCtx(ctx, rng, racer));
}

/**
 * Records that `source`'s power just happened: logs it, and tells everyone else.
 *
 * Scoocher is the only listener — "when another racer's power happens, I move 1".
 */
export function powerHappened(
  ctx: Ctx,
  rng: Rng,
  source: MutableRacer,
  hook: string,
  text: string,
): void {
  ctx.emit({ t: 'ability/triggered', racerId: source.racerId, hook, text });
  for (const other of ctx.s.board) {
    if (other.racerId === source.racerId || other.eliminated) continue;
    hooksFor(ctx.s, other).onOtherPower?.(makeHookCtx(ctx, rng, other), source, text);
  }
}

/** Builds the sandbox a handler runs inside. */
export function makeHookCtx(ctx: Ctx, rng: Rng, self: MutableRacer): HookCtx {
  const live = (): MutableRacer[] =>
    ctx.s.board.filter((r) => !r.eliminated && r.finishedRank === null && r.pos !== FINISH);

  const h: HookCtx = {
    self,
    rng,
    state: ctx.s,

    racers: () => [...ctx.s.board],
    running: live,
    at: (pos: number) => ctx.s.board.filter((r) => !r.eliminated && r.pos === pos),
    sharing: () =>
      ctx.s.board.filter(
        (r) => r.racerId !== self.racerId && !r.eliminated && r.pos === self.pos,
      ),
    alone: () => h.sharing().length === 0,

    lead: () => {
      const field = live();
      if (field.length === 0) return [];
      const best = Math.max(...field.map((r) => r.pos));
      return field.filter((r) => r.pos === best);
    },
    lastPlace: () => {
      const field = live();
      if (field.length === 0) return [];
      const worst = Math.min(...field.map((r) => r.pos));
      return field.filter((r) => r.pos === worst);
    },

    nameOf: (racer) =>
      racerLabel(typeof racer === 'string' ? racer : racer.racerId, ctx.s.racerSets),

    emit: (event) => ctx.emit(event),
    log: (text) => powerHappened(ctx, rng, self, 'power', text),

    next: (...jobs: Job[]) => {
      ctx.s.queue.unshift(...jobs);
    },

    move: (target, distance, reason: MoveReason = 'power') => {
      queueMove(ctx, target, distance, reason, { resolveStop: true });
    },

    // A warp is explicitly not a move, so no racer/moved event and no pass check.
    warp: (target, pos) => warpRacer(ctx, target, pos),

    trip: (target) => tripRacer(ctx, rng, target, self.racerId),

    skipMainMove: () => {
      self.memo[SKIP_MAIN] = true;
    },

    eliminate: (target) => {
      if (target.eliminated) return;
      target.eliminated = true;
      // Elimination order decides who leads the next race, so it must be recorded here
      // rather than inferred later from the board.
      target.eliminationOrder =
        Math.max(0, ...ctx.s.board.map((r) => r.eliminationOrder)) + 1;
      ctx.emit({ t: 'racer/eliminated', racerId: target.racerId, by: self.racerId });
    },

    award: (player: PlayerId, value: number) => {
      const phase = ctx.s.phase;
      if (phase.t !== 'racing' || value === 0) return;
      const token = pointsToken(value, phase.raceNo as RaceNumber);
      scoreOf(ctx.s, player).push(token);
      ctx.emit({ t: 'token/awarded', player, token });
    },

    forfeit: (player: PlayerId, value: number) => {
      const tokens = scoreOf(ctx.s, player);
      let owed = value;
      // Newest chips first, so a loss comes out of this race's chips before older ones.
      for (let i = tokens.length - 1; i >= 0 && owed > 0; i--) {
        const token = tokens[i];
        if (!token || token.kind !== 'points') continue;
        const taken = Math.min(token.value, owed);
        owed -= taken;
        if (taken === token.value) tokens.splice(i, 1);
        else tokens[i] = { ...token, value: token.value - taken };
      }
      const lost = value - owed;
      if (lost > 0) ctx.emit({ t: 'token/lost', player, value: lost });
      return lost;
    },

    rollDie: (target) => rollDieOf(ctx, rng, target),

    mineSpace: (pos) => {
      const phase = ctx.s.phase;
      if (phase.t !== 'racing' || pos <= START || pos >= FINISH) return false;
      if (phase.tripSpaces.includes(pos)) return false;
      if (trackForRace(phase.raceNo as RaceNumber).spaces[pos]?.effect.t === 'trip') return false;
      phase.tripSpaces.push(pos);
      return true;
    },

    defer: (key, data) => {
      ctx.s.queue.unshift({
        t: 'resume',
        racer: self.racerId,
        key,
        data: (data ?? null) as never,
        choice: '' as ChoiceId,
        // A mimic answers under the power it has now, as it would a question asked now.
        ...(isMimic(powerOf(self)) ? { copy: copyTarget(ctx.s, self) } : {}),
      });
    },

    silence: (target) => {
      target.memo[SILENCED] = true;
    },

    addMainMoveBonus: (target, amount) => {
      const had = target.memo[MAIN_MOVE_BONUS];
      target.memo[MAIN_MOVE_BONUS] = (typeof had === 'number' ? had : 0) + amount;
    },

    cutInLine: () => {
      const phase = ctx.s.phase;
      if (phase.t !== 'racing') return;
      // The racer cuts in, not its owner: a teammate does not inherit Skipper's place.
      phase.nextUp.push(self.racerId);
    },

    extraTurn: () => {
      const phase = ctx.s.phase;
      if (phase.t !== 'racing') return;
      phase.extraTurns.push(self.racerId);
    },

    takePlace: () => {
      const phase = ctx.s.phase;
      if (phase.t !== 'racing' || phase.finished.length >= FINISHERS_PER_RACE) return;
      phase.finished.push(self.owner);
      const rank = phase.finished.length;
      self.finishedRank ??= rank;
      ctx.emit({ t: 'racer/finished', racerId: self.racerId, player: self.owner, rank });
    },

    mainRoll: () => {
      const roll = currentRoll(ctx);
      return roll
        ? { mover: roll.racer, value: roll.value, rerolls: roll.rerolls, tags: [...roll.tags] }
        : null;
    },

    rerollMainMove: () => {
      const roll = currentRoll(ctx);
      if (!roll || !roll.die) return;
      const was = roll.value;
      // The die belongs to whoever is taking the turn, not to whoever forced the reroll.
      const mover = findRacer(ctx.s, roll.racer);
      roll.value = mover ? rollDieOf(ctx, rng, mover) : rng.rollD6();
      if (mover) ctx.emit({ t: 'dice/thrown', player: mover.owner, racerId: roll.racer, value: roll.value });
      roll.rerolls += 1;
      roll.stage = 'reroll';
      roll.done = [];
      roll.distance = null;
      roll.cancelled = false;
      roll.modifiedBy = null;
      // Not `powerHappened`: the power that caused the reroll has already logged it, and
      // one reroll is one happening.
      ctx.emit({
        t: 'ability/triggered',
        racerId: roll.racer,
        hook: 'reroll',
        text: `${racerLabel(roll.racer, ctx.s.racerSets)} rerolls the ${was}… and gets ${roll.value}.`,
      });
    },

    setMainMove: (distance) => {
      const roll = currentRoll(ctx);
      if (!roll) return;
      roll.distance = distance;
      roll.modifiedBy = self.racerId;
    },

    cancelMainMove: () => {
      const roll = currentRoll(ctx);
      if (!roll) return;
      roll.cancelled = true;
      roll.modifiedBy = self.racerId;
    },

    tagMainRoll: (tag) => {
      const roll = currentRoll(ctx);
      if (roll && !roll.tags.includes(tag)) roll.tags.push(tag);
    },

    borrowPower: (power) => {
      self.memo[BORROWED] = power;
    },

    undrafted: () => {
      const drafted = new Set(Object.values(ctx.s.hands).flat());
      // The deck is the chosen sets, so Egg never hatches into a racer from a set not in play.
      return racersInSets(ctx.s.racerSets).filter((id) => !drafted.has(id));
    },

    previousWinners: () => {
      // The gold cup for race N went to whoever's racer won it, and a player's Nth used
      // racer is the one they raced in race N.
      const winners: { raceNo: number; racer: RacerId }[] = [];
      for (const [player, tokens] of Object.entries(ctx.s.scores)) {
        for (const token of tokens) {
          if (token.kind !== 'gold') continue;
          const racer = ctx.s.used[player as PlayerId]?.[token.raceNo - 1];
          if (racer) winners.push({ raceNo: token.raceNo, racer });
        }
      }
      return winners.sort((a, b) => a.raceNo - b.raceNo).map((w) => w.racer);
    },

    ask: (req: AskRequest) => ask(ctx, self, req),
  };
  return h;
}

/**
 * Suspends the queue on a question.
 *
 * Deliberately does not touch the queue. The continuation lives on `pending.resume`, so
 * during a suspension the queue holds only the interrupted work, and the job that was
 * interrupted re-queues itself without reasoning about where a resume job might sit.
 */
function ask(ctx: Ctx, self: MutableRacer, req: AskRequest): void {
  invariant(req.options.length > 0, `${self.racerId} asked a question with no options`);
  invariant(ctx.s.pending === null, 'two powers suspended at once');

  const first = req.options[0];
  invariant(first, 'unreachable: options is non-empty');

  const descriptor: ResumeDescriptor = {
    racer: self.racerId,
    key: req.key,
    data: req.data ?? null,
    ...(isMimic(powerOf(self)) ? { copy: copyTarget(ctx.s, self) } : {}),
  };

  ctx.s.pending = {
    player: req.player,
    source: self.racerId,
    prompt: req.prompt,
    options: req.options.map((o) => ({ ...o })),
    resume: descriptor as unknown as Record<string, unknown>,
    defaultChoice: req.defaultChoice ?? first.id,
  } as never;

  ctx.emit({
    t: 'decision/requested',
    player: req.player,
    source: self.racerId,
    prompt: req.prompt,
  });
}

/** Applies an answer and rebuilds the resume job in front of the interrupted work. */
export function answerPending(ctx: Ctx, choice: ChoiceId, auto: boolean): void {
  const { s } = ctx;
  const pending = s.pending;
  invariant(pending, 'answerPending with nothing pending');

  const chosen = pending.options.find((o) => o.id === choice);
  invariant(chosen, `choice '${choice}' is not on offer`);

  const descriptor = pending.resume as unknown as ResumeDescriptor;
  s.queue.unshift({
    t: 'resume',
    racer: descriptor.racer,
    key: descriptor.key,
    data: descriptor.data as never,
    choice,
    ...(descriptor.copy !== undefined ? { copy: descriptor.copy } : {}),
  });

  ctx.emit({
    t: 'decision/made',
    player: pending.player,
    choice,
    label: chosen.label,
    auto,
  });
  s.pending = null;
}
