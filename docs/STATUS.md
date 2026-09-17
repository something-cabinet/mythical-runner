# Status & Handoff

**Last updated:** 2026-09-17 · **Phases 0–3 complete, phase 4 next.**

Start here when picking this project back up. It is written to be read cold, without the
conversation that produced it.

---

## 1. What this is

A web implementation of *Magical Athlete* (CMYK 2025 edition): room-based, multiplayer,
turn-based, running at **$0/month** on Cloudflare's free tier.

| Document | Role |
|-|-|
| [magical-athlete-rules.md](./magical-athlete-rules.md) | **The rules authority.** Full rulebook, all 36 racers. Where the engine disagrees with this, the engine is wrong |
| [plan-cloudflare.md](./plan-cloudflare.md) | The implementation plan being followed. §5.4–5.6 describe the server *as built* |
| [plan-vercel-supabase.md](./plan-vercel-supabase.md) | Rejected alternative, kept for comparison. Marked "Not used" |
| `How-to-play-MAGICAL-ATHLETE_compressed.pdf` | Source PDF the rules came from |

Stack: **Vite + React + TypeScript (static)** on Workers Static Assets, plus a
**Cloudflare Worker + Durable Object** per room over WebSockets.

---

## 2. Where things stand

```
packages/engine/     COMPLETE — the whole game as a pure function, no runtime dependencies
apps/server/         COMPLETE — Worker + RoomDO, runs locally under wrangler dev
apps/web/            NOT STARTED (phase 4)
```

A full game is playable over WebSockets against the real server. There is no UI yet.
**Nothing has been deployed** — everything has only run locally.

### Verify it still works

```bash
npm install
npm run typecheck                    # all workspaces
npm test                             # engine: 51 scenario checks + 1000 fuzzed games

# server end-to-end — needs two terminals
npm run dev -w @mr/server            # terminal 1: wrangler dev on 127.0.0.1:8787
npm run e2e -w @mr/server            # terminal 2: 38 checks, ~40 s
npm run e2e -w @mr/server -- --fast  # skips the 15-second turn-clock scenario
```

Last run: **engine 51/51 + 1000 games clean; server e2e 38/38; cold-restart persistence
test passed.**

The cold-restart test is not in the repo — it was run by hand. See §4, "Proving persistence".

### Git

Branch `main`, tracking `origin/main` on GitHub. Last commit `07cd1e1` (phases 0–2).
**Phase 3 is uncommitted.** npm workspaces, not pnpm (pnpm is not installed on this machine).

---

## 3. Decisions that are load-bearing

Do not re-litigate these without reading the reasoning. Each was arrived at by hitting the
problem, not by preference.

### Engine

**A pure function.** No I/O, no dependencies. The same module runs in the Durable Object as
the authority and, in phase 4, can run in the browser.

```ts
initGame(seed: number): GameState
applyAction(state: GameState, action: Action): { state, events[] }
legalActions(state, playerId): Action[]
redact(state, playerId): PlayerView
```

`applyAction` takes **no RNG parameter** — randomness derives from
`makeRng(state.seed, state.step)`. A caller advancing the stream out of lockstep with `step`
would desync replays. The fuzzer verifies every game replays byte-identically.

**A turn is a job queue, not a call stack.** `GameState.queue` holds the turn as plain data
([jobs.ts](../packages/engine/src/jobs.ts)), because a power can suspend mid-move to ask a
player something, and the Durable Object may hibernate before they answer. Jobs are **popped
before they run** (peeking made a suspended job re-run forever), and the continuation lives on
**`pending.resume`**, not pre-queued. A scenario test asserts a suspended turn survives a JSON
round trip — the hibernation case, tested directly.

**Three rules the pipeline is shaped around**, all got wrong on a first pass built from
reviews. Check these first if something feels off:

- **Passing** is judged once a move completes, comparing start and end — never per step.
- **Tripping** does not end the current move; it skips only the roll of the next main move,
  and powers still fire.
- **Sharing a space** requires both racers to be *stopped* there.

**Other settled points:** `START = 0` (the Start space is a space); points are a plain number
with no chip denominations; race 1 turn order by roll-off, races 2–4 by farthest-behind or
first-eliminated; warps emit `racer/warped` not `racer/moved`; **balance is not a goal**.

### Server

**Persistence is per action, not debounced.** The original plan said debounce. That was
wrong: a pending `setTimeout` *prevents* hibernation, and eviction mid-debounce loses moves
clients already saw. One write per action is ~200 rows a game, so the 100k/day free budget
still covers ~500 games a day. Do not "optimise" this back into a debounce.

**The server tells each client what it may do.** Every `state` message carries `legal` — that
player's permitted actions, computed server-side. The client must render buttons from it and
**must not** call `legalActions` itself: that needs the full `GameState`, and a client only
has a `PlayerView` with commits masked. It would silently give wrong answers during the
commit phase.

**`by` is stamped from the authenticated socket**, never read from the message. Clients may
send only the eight types in `CLIENT_ACTION_TYPES`; joins, connection changes and timeouts
are server-originated.

**Identity is trust-on-first-use.** The browser invents a random `playerId` and `secret`,
keeps them in localStorage per room, and the room stores a SHA-256 of the secret the first
time it sees that id. `playerId` is public; the secret proves who you are.

**Reconnect sends a full snapshot**, not a replay of missed events.

**Rejections are delivered as close codes** — 4000 bad request, 4001 bad credentials, 4003
full or in progress, 4004 no such room — preceded by an `error` message. A browser cannot
read the HTTP status of a failed upgrade, but it can read these.

**An empty room pauses its clock** rather than auto-playing to the end, and deletes itself
6 hours after the last player leaves.

---

## 4. Traps

Things that cost time once and will again.

### Engine

- **`DeepMutable` must check primitives first.** Branded ids are `string & { [brand] }`,
  structurally an object; without the early exit the brand is silently destroyed.
- **Narrowing of `s.phase` is lost after any `ctx.emit(...)`.** Capture `const phase = s.phase`
  once after the invariant, as `endTurn` does.
- **The engine declares its own globals** in `globals.d.ts` rather than using `@types/node`
  or the DOM lib. The server compiles the engine's source against `@cloudflare/workers-types`
  without conflict *only because nothing imports `globals.d.ts`*. Keep it that way.
- **Scenario tests force dice by searching seeds**, not by mocking the RNG.

### Server

- **Stopping `wrangler dev` on Windows leaves `workerd.exe` running**, still serving the port
  and still holding every room in memory. A "restart" that does not kill it tests nothing. To
  stop it for real:

  ```powershell
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like '*mythical-runner*' -and
      ($_.Name -eq 'workerd.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*wrangler*')) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```

  Then confirm `http://127.0.0.1:8787/api/health` no longer answers.

- **Proving persistence.** Start `wrangler dev`, get a game into race 2, disconnect everyone,
  kill the process tree as above, start it again, reconnect with the same credentials.
  Phase, active player, scores, used racers and board positions must all come back. Local
  room storage lives in `apps/server/.wrangler/` (gitignored); deleting it wipes all local
  rooms.

- **Drafted hands are public.** A test that greps a player's frame for an opponent's committed
  racer id will "find a leak" — it is in `hands`, because the draft is face-up. Check that
  nothing *outside* `hands` reveals the choice.

- **Instance fields in `RoomDO` do not survive hibernation.** Anything that must persist goes
  in storage; anything per-socket goes in `serializeAttachment` (16 KB limit).

---

## 5. What is next

### Phase 4 — the web client (the immediate task)

`apps/web/` does not exist yet. Gate: **playable on a phone.**

**Stack:** Vite + React + TypeScript, built to static files. Import types from `@mr/engine`,
including everything in [protocol.ts](../packages/engine/src/protocol.ts).

**Serving.** Add an `assets` block to [wrangler.jsonc](../apps/server/wrangler.jsonc) pointing
at `../web/dist`, with `not_found_handling: "single-page-application"` and
`run_worker_first: ["/api/*"]`, so one Worker serves the SPA and the API from the same origin.
That same-origin arrangement is why there is no CORS code anywhere — keep it. In development,
point Vite's dev-server proxy at `http://127.0.0.1:8787` for `/api` (with `ws: true`).

**Talking to the server.**

1. Create: `POST /api/rooms` with `{ turnSeconds }` → `{ code }`.
2. Before joining, `GET /api/rooms/:code` to show "no such room" or "game in progress" without
   opening a socket.
3. Look up `{ playerId, secret }` in localStorage under the room code; generate if absent.
   `playerId` must match `^[A-Za-z0-9_-]{8,64}$` and `secret` `^[A-Za-z0-9_-]{16,128}$` —
   use `crypto.getRandomValues`.
4. Open `/api/rooms/:code/ws?playerId=…&secret=…&name=…`.
5. On every `state` message, replace the local view wholesale and render. Animate from
   `events`; enable buttons from `legal`; send `{ t: 'action', action }` with an entry from
   `legal` as-is.
6. On close, read the close code: 4001/4003/4004 are final, show a message; anything else,
   reconnect with backoff using the same credentials.

**Rendering notes.**

- `view.deadline` is a Unix-ms timestamp for the countdown; `turnSeconds` 0 means no clock.
- Animate `racer/moved` one hop at a time (~180 ms). `racer/warped` should *snap*, not hop —
  a warp is not a move, and animating it as one would mislead players about what happened.
- `view.pending` non-null with `pending.player === view.you` means *you* must answer; show
  its `prompt` and `options`. When it is someone else's, show who the table is waiting on.
- Card text must always be visible. With 36 rule-breaking powers, hiding it is the main
  usability failure mode. `racerName` and `racerText` are exported from the engine.
- `racer/passed`, `racer/tripped` and `ability/triggered` are what make the chaos legible.
  `ability/triggered` already carries a human-readable `text`.

### Phase 5 — the remaining 27 racers

**Not blocked.** Card text for all 36 is in the rules doc. 9 are implemented in
[characters/defs/index.ts](../packages/engine/src/characters/defs/index.ts); the rest are
vanilla padding. Each is: write the def, add a scenario test.

Several need hooks that do not exist yet — Skipper and Genius reorder turns, Copycat and Twin
borrow another racer's power, Flip Flop and Hypnotist warp. **Extend `Hooks`** rather than
special-casing inside the pipeline.

Can be done before, after or alongside phase 4. Doing it first means the UI is built against
the full range of decisions and events a real game produces.

### Phase 6 — polish

Spectators, replay viewer, fill bots, sound. Possibly a shorter clock for disconnected
players specifically — currently an absent player costs the table a full `turnSeconds` per
turn.

### Deploying

Not done, and needs you: `wrangler deploy` requires `wrangler login`, an interactive browser
OAuth flow. Once logged in, `npm run deploy -w @mr/server` from a Cloudflare account on the
**free plan with no payment method**, which is what makes the free-tier limits hard stops
rather than bills. Do this after phase 4, since there is nothing to look at before then.

---

## 6. Open items

- **The Wild Wilds space layout is invented.** The rulebook documents the space types but not
  the board. Isolated in [tracks/wildWilds.ts](../packages/engine/src/tracks/wildWilds.ts);
  replacing it from the physical board is a one-file change.
- **Credentials travel in the WebSocket URL's query string**, so they appear in any log that
  records full URLs. Acceptable for a friends' game; revisit if that changes.
- **Legal:** a commercial, in-print game. Private play is fine; publishing with the real racer
  names and artwork is not.
