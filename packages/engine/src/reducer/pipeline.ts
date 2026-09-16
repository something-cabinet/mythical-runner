import { getHooks, racerName } from '../characters/registry.js';
import type { AskRequest, HookCtx, MutableRacer } from '../characters/hooks.js';
import { invariant } from '../errors.js';
import type { ChoiceId, PlayerId, RacerId } from '../ids.js';
import type { Job, MoveReason, ResumeDescriptor } from '../jobs.js';
import type { Rng } from '../rng.js';
import { pointsToken } from '../scoring.js';
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
    case 'beforeMove':
      return fireSelf(ctx, rng, job.racer, 'beforeMainMove');
    case 'mainMove':
      return doMainMove(ctx, job.racer, rng);
    case 'move':
      return doMoveStep(ctx, job, rng);
    case 'passCheck':
      return doPassCheck(ctx, job, rng);
    case 'spaceEffect':
      return doSpaceEffect(ctx, job.racer);
    case 'stopHooks':
      return doStopHooks(ctx, job, rng);
    case 'turnEnd':
      return fireSelf(ctx, rng, job.racer, 'onTurnEnd');
    case 'endTurn':
      // Owned by racing.ts, injected on Ctx to avoid a circular import.
      return ctx.onEndTurn();
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
 * Queues a move, capturing what is needed to judge passing when it completes.
 *
 * Every move in the game goes through here, so the pass rule is applied uniformly whether
 * the movement came from a die, a power or an arrow.
 */
export function queueMove(
  ctx: Ctx,
  racer: MutableRacer,
  distance: number,
  reason: MoveReason,
  opts: { isMainMove?: boolean; resolveStop?: boolean; front?: boolean } = {},
): void {
  // "Moving 0 doesn't count as moving" — not even enough to trigger a pass check.
  if (distance === 0) return;

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
  };

  if (opts.front === false) ctx.s.queue.push(job);
  else ctx.s.queue.unshift(job);
}

// --- Jobs -------------------------------------------------------------------

function doMainMove(ctx: Ctx, racerId: RacerId, rng: Rng): void {
  const racer = findRacer(ctx.s, racerId);
  invariant(racer, `main move for missing racer ${racerId}`);
  if (racer.eliminated || racer.finishedRank !== null) return;

  if (racer.tripped) {
    // "A tripped racer skips their next main move! You don't even roll your die, though
    // your powers can still trigger and you can still move in other ways."
    racer.tripped = false;
    ctx.emit({ t: 'racer/stoodUp', racerId });
    return;
  }

  const hooks = getHooks(racerId);
  const h = makeHookCtx(ctx, rng, racer);

  let value: number;
  let modifiedBy: RacerId | undefined;

  const replaced = hooks.replaceMainMove?.(h) ?? null;
  if (replaced !== null) {
    value = replaced;
    modifiedBy = racerId;
  } else {
    value = rng.rollD6();
  }

  // Every racer on the board may adjust the main move — Gunk goops opponents, Coach
  // hustles anyone sharing his space. Self applies last so its own bonus is not lost.
  const before = value;
  for (const other of ctx.s.board) {
    if (other.eliminated) continue;
    const fn = getHooks(other.racerId).modifyMainMove;
    if (!fn) continue;
    if (other.racerId === racerId) continue;
    value = fn(makeHookCtx(ctx, rng, other), value);
  }
  value = hooks.modifyMainMove?.(h, value) ?? value;
  if (value !== before) modifiedBy ??= racerId;

  ctx.emit({
    t: 'dice/rolled',
    player: racer.owner,
    racerId,
    value,
    ...(modifiedBy ? { modifiedBy } : {}),
  });

  queueMove(ctx, racer, value, 'main', { isMainMove: true });
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
    if (job.resolveStop) {
      tail.push({ t: 'spaceEffect', racer: job.racer });
      tail.push({ t: 'stopHooks', racer: job.racer, done: [] });
    }
    if (tail.length > 0) ctx.s.queue.unshift(...tail);
  };

  if (job.remaining <= 0 || racer.eliminated || racer.pos === FINISH) return settle();

  const next = racer.pos + job.dir;
  if (next < START) {
    // Clamped at Start; the rest of the movement is simply lost.
    job.remaining = 0;
    return settle();
  }
  if (next > FINISH) {
    job.remaining = 0;
    return settle();
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
  applyDisplacement(ctx, racer, job.dir, rng);
  settle();
}

/**
 * Huge Baby: "No one can ever be on my space, besides the Start. Whenever that would
 * happen, put the racer on the space behind me instead."
 *
 * Explicitly not a move — "it's like they just stopped on that space instead" — so it
 * emits no `racer/moved` and cannot trigger movement-based powers.
 */
function applyDisplacement(ctx: Ctx, racer: MutableRacer, dir: 1 | -1, rng: Rng): void {
  let guard = 0;
  for (;;) {
    invariant(guard++ < 64, 'displacement did not settle');
    if (racer.pos === START || racer.pos === FINISH) return;

    const blocker = ctx.s.board.find(
      (o) =>
        o.racerId !== racer.racerId &&
        !o.eliminated &&
        o.pos === racer.pos &&
        getHooks(o.racerId).blocksSpace?.(makeHookCtx(ctx, rng, o), racer) === true,
    );
    if (!blocker) return;

    const to = Math.max(START, blocker.pos - 1);
    if (to === racer.pos) return;
    ctx.emit({
      t: 'ability/triggered',
      racerId: blocker.racerId,
      hook: 'blocksSpace',
      text: `${racerName(racer.racerId)} can't fit past ${racerName(blocker.racerId)} and settles behind them.`,
    });
    racer.pos = to;
    void dir;
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

    getHooks(racer.racerId).onPass?.(makeHookCtx(ctx, rng, racer), other);
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }

    getHooks(other.racerId).onPassed?.(makeHookCtx(ctx, rng, other), racer);
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
  }
}

function doSpaceEffect(ctx: Ctx, racerId: RacerId): void {
  const racer = findRacer(ctx.s, racerId);
  if (!racer || racer.eliminated || racer.pos === FINISH) return;

  const phase = ctx.s.phase;
  invariant(phase.t === 'racing', 'space effect resolved outside a race');

  const track = trackForRace(phase.raceNo as RaceNumber);
  const space = track.spaces[racer.pos];
  invariant(space, `no space at ${racer.pos} on ${track.id}`);

  switch (space.effect.t) {
    case 'plain':
      return;

    case 'arrow': {
      const amount = space.effect.amount;
      ctx.emit({
        t: 'ability/triggered',
        racerId,
        hook: 'space',
        text:
          amount > 0
            ? `${racerName(racerId)} is swept ${amount} forward!`
            : `${racerName(racerId)} is knocked ${-amount} back!`,
      });
      // "A separate move than how you got there, and never part of your main move."
      // resolveStop false, or two arrows facing each other would loop forever.
      queueMove(ctx, racer, amount, 'space', { resolveStop: false });
      return;
    }

    case 'trip':
      if (!racer.tripped) {
        racer.tripped = true;
        ctx.emit({ t: 'racer/tripped', racerId, by: null });
      }
      return;

    case 'star': {
      if (phase.claimedSpaces.includes(racer.pos)) return;
      phase.claimedSpaces.push(racer.pos);
      const token = pointsToken(space.effect.value, phase.raceNo as RaceNumber);
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
 */
function doStopHooks(ctx: Ctx, job: Extract<Job, { t: 'stopHooks' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer || racer.eliminated) return;

  if (!job.done.includes(racer.racerId)) {
    job.done.push(racer.racerId);
    getHooks(racer.racerId).onStop?.(makeHookCtx(ctx, rng, racer));
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
  }

  for (const other of ctx.s.board) {
    if (other.racerId === racer.racerId || other.eliminated) continue;
    if (job.done.includes(other.racerId)) continue;
    job.done.push(other.racerId);

    getHooks(other.racerId).onOtherStops?.(makeHookCtx(ctx, rng, other), racer);
    if (ctx.s.pending) {
      ctx.s.queue.unshift(job);
      return;
    }
  }
}

function doResume(ctx: Ctx, job: Extract<Job, { t: 'resume' }>, rng: Rng): void {
  const racer = findRacer(ctx.s, job.racer);
  if (!racer) return; // the power's owner left the board while we waited

  const hooks = getHooks(job.racer);
  invariant(hooks.resume, `${job.racer} suspended but defines no resume handler`);
  hooks.resume(makeHookCtx(ctx, rng, racer), job.key, job.choice, job.data);
}

// --- Hook dispatch ----------------------------------------------------------

function fireSelf(
  ctx: Ctx,
  rng: Rng,
  racerId: RacerId,
  name: 'onRaceStart' | 'beforeMainMove' | 'onStop' | 'onTurnEnd',
): void {
  const racer = findRacer(ctx.s, racerId);
  if (!racer || racer.eliminated) return;
  const fn = getHooks(racerId)[name] as ((h: HookCtx) => void) | undefined;
  fn?.(makeHookCtx(ctx, rng, racer));
}

/** Fires "before my race" powers for everyone, in board order. */
export function fireRaceStart(ctx: Ctx, rng: Rng): void {
  for (const racer of [...ctx.s.board]) fireSelf(ctx, rng, racer.racerId, 'onRaceStart');
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

    emit: (event) => ctx.emit(event),
    log: (text) =>
      ctx.emit({ t: 'ability/triggered', racerId: self.racerId, hook: 'power', text }),

    next: (...jobs: Job[]) => {
      ctx.s.queue.unshift(...jobs);
    },

    move: (target, distance, reason: MoveReason = 'power') => {
      queueMove(ctx, target, distance, reason, { resolveStop: true });
    },

    warp: (target, pos) => {
      const to = Math.max(START, Math.min(FINISH, pos));
      if (to === target.pos) return;
      target.pos = to;
      // A warp is explicitly not a move, so no racer/moved event and no pass check.
      ctx.emit({ t: 'racer/warped', racerId: target.racerId, to });
      ctx.s.queue.unshift({ t: 'stopHooks', racer: target.racerId, done: [] });
    },

    trip: (target) => {
      if (target.tripped || target.eliminated) return;
      target.tripped = true;
      ctx.emit({ t: 'racer/tripped', racerId: target.racerId, by: self.racerId });
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
