# Status & Handoff

**Last updated:** 2026-09-16 · **Phases 0–2 complete, phase 3 next.**

Start here when picking this project back up. It is written to be read cold, without the
conversation that produced it.

---

## 1. What this is

A web implementation of *Magical Athlete* (CMYK 2025 edition): room-based, multiplayer,
turn-based, running at **$0/month** on Cloudflare's free tier.

| Document | Role |
|-|-|
| [magical-athlete-rules.md](./magical-athlete-rules.md) | **The rules authority.** Full rulebook, all 36 racers. Where the engine disagrees with this, the engine is wrong |
| [plan-cloudflare.md](./plan-cloudflare.md) | The implementation plan being followed |
| [plan-vercel-supabase.md](./plan-vercel-supabase.md) | Rejected alternative, kept for comparison. Marked "Not used" |
| `How-to-play-MAGICAL-ATHLETE_compressed.pdf` | Source PDF the rules came from |

Target stack: **Vite + React + TypeScript (static)** on Workers Static Assets, plus a
**Cloudflare Worker + Durable Object** per room over WebSockets. Reasoning, cost analysis and
free-tier limits are in the plan §3.

---

## 2. Where things stand

```
packages/engine/     COMPLETE through phase 2 — 29 source files, no runtime dependencies
apps/server/         NOT STARTED (phase 3)
apps/web/            NOT STARTED (phase 4)
```

The engine plays a full four-race game end to end, with working powers including ones that
suspend mid-turn to question a player who is not taking it.

### Verify it still works

```bash
npm install
npm run typecheck                              # whole workspace
npm test                                       # 51 scenario checks + 1000 fuzzed games
npm run hotseat -w @mr/engine -- 20260916 4    # one narrated game
npm run fuzz    -w @mr/engine -- 2000 1        # bigger sweep
npm run scenarios -w @mr/engine                # per-racer tests alone
```

Last run: **51/51 checks, 1000 games, 0 failures, 0 replay mismatches, 0 stalemates.**

### Git

Branch `main`, one commit (`Initial commit`), and **everything since is uncommitted** —
including the whole phase 1/2 build and the rules rework. Nothing has been committed on
purpose; commit when you are ready.

`pnpm` is not installed on this machine, so the repo uses **npm workspaces**.

---

## 3. Decisions that are load-bearing

Do not re-litigate these without reading the reasoning. Each was arrived at by hitting the
problem, not by preference.

### The engine is a pure function

`packages/engine` has no I/O, no React, no network and zero dependencies. The same module
will run on the client for prediction and inside the Durable Object as the authority.

```ts
initGame(seed: number): GameState
applyAction(state: GameState, action: Action): { state, events[] }
legalActions(state, playerId): Action[]
redact(state, playerId): PlayerView
```

`applyAction` deliberately takes **no RNG parameter** — randomness derives internally from
`makeRng(state.seed, state.step)`. A caller advancing the stream out of lockstep with `step`
would desync replays in a way that is near-impossible to debug. Verified by the fuzzer: every
game's action log replays to a byte-identical final state.

### A turn is a job queue, not a call stack

`GameState.queue` holds the turn as plain serializable data ([jobs.ts](../packages/engine/src/jobs.ts)).
A power can suspend mid-move to ask a player something, and the answer may not arrive for
minutes — during which the Durable Object hibernates and the JS call stack ceases to exist.

Two things that took a false start to get right:

- **Jobs are popped before they run, not peeked.** An earlier version retired a job only if
  nothing had been pushed in front of it, so a suspended job stayed at the head and re-ran on
  resume — an optional power would re-ask forever.
- **The continuation lives on `pending.resume`, not pre-queued.** During a suspension the
  queue holds only the interrupted work, so the interrupted job re-queues itself normally.
  `answerPending` then unshifts the resume job in front of it.

A scenario test asserts a suspended turn survives a JSON round trip and resumes identically.
That is the hibernation case, tested directly — keep it passing.

### Three rules the pipeline is shaped around

All three were got **wrong** on the first pass, from published reviews, before the rulebook
arrived. If something feels off, check these first:

- **Passing** is *"starts a move behind a racer and ends the same move ahead of them"* —
  judged once the whole move completes, never space by space. Implemented as a `passCheck`
  job; moves capture `startBehind` when queued so the rule applies identically to dice,
  powers and arrows.
- **Tripping** *"doesn't end your current move prematurely"*. Finish the move, then fall. A
  tripped racer skips only the roll and movement of their next main move — `beforeMainMove`
  and every other power still fires. Stand-up happens inside the `mainMove` job for exactly
  this reason.
- **Sharing a space** requires both racers to be *stopped* there. Temporary overlap during a
  move does not count, so there are no per-step occupancy triggers.

### Other settled points

- **Positions:** `START = 0` (the Start space *is* a space, per the rules), track spaces
  `0..29`, `FINISH = 30`.
- **Points are a plain number.** The physical 3-point chips are just change for three
  1-point chips; nothing awards a "3-point chip" as a distinct reward. There is no supply to
  exhaust.
- **Turn order:** race 1 by roll-off; races 2–4 the player whose racer was farthest behind or
  eliminated first. Needed a `eliminationOrder` field — it cannot be recovered from position.
  The roll-off survives as a fallback for when nobody is behind (a 2-player race where both
  crossed).
- **Warps emit `racer/warped`, not `racer/moved`**, because the rules say a warp "doesn't
  count as moving" for triggering powers or passing.
- **Balance is not a goal.** The fuzzer reports win distribution by seat as a *bug detector* —
  a seat winning too rarely usually means it is being skipped. Do not tune for fairness.

---

## 4. Traps

Things that cost time once and will again.

- **`DeepMutable` must check primitives first.** Branded ids are `string & { [brand] }`,
  structurally an object; without the early exit the mapped type recurses into
  `String.prototype` and silently destroys every `PlayerId`.
- **TypeScript narrowing of `s.phase` is lost after any `ctx.emit(...)`.** Capture
  `const phase = s.phase` once after the invariant, as `endTurn` does.
- **The engine declares its own globals** (`structuredClone`, `console`, `process`, `Date`,
  `JSON`) in `globals.d.ts` rather than pulling in `@types/node` or the DOM lib. This keeps
  it runnable unchanged inside a Durable Object. `process` and `console` are for `src/dev/`
  only — the engine proper must not use them.
- **Scenario tests force dice by searching seeds**, not by mocking the RNG, so they exercise
  the real engine. If a test starts failing after an engine change, the seed it found may no
  longer produce that roll — that is expected, and the helper re-searches automatically.

---

## 5. What is next

### Phase 3 — Worker + Durable Object (the immediate task)

Nothing exists in `apps/server/` yet. Full spec in [plan-cloudflare.md §5.4](./plan-cloudflare.md).
Gate: **two browsers play a full game.**

- `POST /api/rooms` → Worker mints a 4-char join code, creates `RoomDO` by that name.
- WS at `/api/rooms/:code/ws?playerId=…&token=…`.
- Every inbound message: verify token → check against `legalActions` → `applyAction` →
  broadcast `redact(state, p)` plus new events to each player individually.
- **Must use the SQLite storage backend** (`new_sqlite_classes` in the migration, not
  `new_classes`). KV-backed Durable Objects are paid-only; SQLite-backed ones are on the free
  plan.
- **WebSocket Hibernation API is mandatory**, not an optimisation — use `acceptWebSocket()`
  plus `webSocketMessage`/`webSocketClose`, never `addEventListener`. A non-hibernating DO
  holding sockets open burns the 13,000 GB-s/day duration allowance. Consequence: the DO must
  rebuild from storage on wake and must not rely on instance fields surviving.
- **Never send the client the seed** — they could precompute every roll. `redact` handles it;
  do not bypass it.
- Persist with a **debounced snapshot** (timer + phase boundaries), not per action. 100k
  row-writes/day is the tightest free limit.
- Turn timer via `storage.setAlarm()`, firing `system/timeout`, which the engine already
  handles for every phase including auto-answering a pending decision.

### Phase 4 — Web client

`apps/web/`, Vite + React, static. SVG track, animation queue driven off the event stream at
roughly one hop per 180 ms. Card text must always be visible — with 36 rule-breaking powers,
hiding it is the main usability failure mode.

### Phase 5 — the remaining 27 racers

**No longer blocked.** Card text for all 36 is in the rules doc. 9 are implemented in
[characters/defs/index.ts](../packages/engine/src/characters/defs/index.ts); the rest are
vanilla padding in the registry. Adding one is: write the def, add a scenario test.

Several will want hooks that do not exist yet — Skipper and Genius reorder turns, Copycat and
Twin borrow another racer's power, Flip Flop and Hypnotist warp. Extend `Hooks` rather than
special-casing in the pipeline.

### Phase 6 — polish

Spectators, replay viewer, fill bots, sound.

---

## 6. Open items

- **The Wild Wilds space layout is invented.** The rulebook documents the three space types
  (signed arrows, TRIP, stars) but does not print the board. The layout in
  [tracks/wildWilds.ts](../packages/engine/src/tracks/wildWilds.ts) is plausible, not
  accurate. Isolated in one file with nothing depending on the arrangement — replacing it
  from the physical board is a one-file change.
- **The 9 vs 16 bronze chip split** is resolved as "denominations only" and the engine
  ignores it. Noted here in case the physical board turns out to have 3-point star spaces.
- **Legal:** this is a commercial, in-print game. Private play is fine; publishing it with
  the real racer names and artwork is not. Original art and a neutral name would be needed
  before anything goes public.
