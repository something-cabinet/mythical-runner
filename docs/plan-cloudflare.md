# Mythical Runner — Implementation Plan (Cloudflare)

A web implementation of *Magical Athlete* (CMYK 2025 edition): room-based, multiplayer,
turn-based, running at zero cost on Cloudflare's free plan.

- **Stack:** Vite + React + TypeScript (static) · Cloudflare Worker + Durable Objects · WebSockets
- **Cost:** $0/month, enforced by hard limits rather than overage billing
- **Status:** phases 0–4 complete — the game is playable end to end in a browser. Phase 5 is next. See **[STATUS.md](./STATUS.md)** for the
  handoff note — where things stand, how to verify, and what to do next. That file is the
  place to start in a new session; this one is the design it is following.

---

## 1. The source game

*Magical Athlete*, CMYK 2025 edition ([BGG #454103](https://boardgamegeek.com/boardgame/454103/magical-athlete)).

| Element | Rule |
|-|-|
| Players | 2–6, ~30 min |
| Draft | Roll-off for first player (highest unique die). Lay out 2 racer cards per player; snake draft until each player holds **4 racers** |
| Races | **4 races**. Track is 30 spaces, double-sided: *Mild Mile* (plain) and *Wild Wilds* (spaces that push racers forward/back and award point tokens). Board flips between races |
| Race start | All players **simultaneously and secretly** commit one unused racer, reveal, place meeples on the start space |
| Turn order | Race 1 by roll-off. Races 2–4: the player whose racer finished **farthest behind (or was eliminated first)** goes first — a catch-up rule, not a roll-off |
| Turn | In player order: roll d6, move that many spaces. Abilities trigger *before*, *after*, or *instead of* rolling |
| Status | Tripped racers lie down and spend their next turn standing up instead of moving |
| Race end | Ends the moment **two** racers cross the finish line → 1st gets the gold cup, 2nd the silver cup. Everyone else scores nothing |
| Scoring | Cup values escalate across the 4 races — gold 3/4/4/5, silver 1/2/2/3. Star spaces and some powers give bronze point chips |
| Win | Most points after race 4 |

**36 racers**, each with a deliberately rule-breaking power.

### The rules are settled

[magical-athlete-rules.md](./magical-athlete-rules.md) is the **authority** — full rulebook
text including all 36 racers' powers and their clarifying notes. Where the engine disagrees
with it, the engine is wrong. The phase 5 card-text dependency is closed.

Three rules shape the engine more than any other, and all three were got wrong on the first
pass:

- **Passing** is *"when a racer starts a move behind a racer and ends the same move ahead of
  them"* — judged once the whole move completes, never space by space.
- **Tripping** *"doesn't end your current move prematurely"*: finish the move, then fall. A
  tripped racer skips their next main move but their powers still trigger.
- **Sharing a space** requires both racers to be *stopped* there. *"If racers temporarily
  occupy the same space over the course of moving, warping, etc. — that doesn't count!"*

### Legal note

This is a commercial, in-print game. A private implementation for personal play is fine;
publishing it with the real racer names and artwork is not. Original art and a neutral name
would be required before anything goes public.

---

## 2. Does it need a server?

Yes. There is no honest static-only version:

- Rooms and invites need somewhere to hold state between page loads.
- Secret simultaneous racer selection needs a referee nobody can peek at.
- Dice need a source neither client controls.
- Reconnects need a snapshot to resume from.

P2P WebRTC still requires a signalling server *and* makes cheating trivial, so it saves
nothing.

What you do **not** need is a machine to babysit. Durable Objects give one addressable,
single-threaded, stateful object per room, which maps 1:1 onto the problem.

---

## 3. Cost analysis — why this is $0

SQLite-backed Durable Objects have been on the Workers Free plan since April 2025.

Two conditions:

1. Must use the **SQLite storage backend** (`new_sqlite_classes` in the migration, not
   `new_classes`). Legacy KV-backed DOs are paid-only. Not a limitation — the familiar
   `storage.put/get` KV API still works on top of SQLite.
2. Free limits are **hard stops, not overages**. Exceeding one fails the operation with an
   error rather than generating a bill. With no payment method on the account there is no
   path to a surprise charge.

| Limit | Free / day | Projected usage |
|-|-|-|
| DO requests | 100,000 | Inbound WS messages bill at **20:1** → ~2M messages/day. A 6-player game is a few hundred messages ≈ 25 request-equivalents. Thousands of games/day |
| DO duration | 13,000 GB-s | ~29 h of *active compute* at 128 MB. With hibernation, time is only burned while processing a message |
| SQL rows written | 100,000 | **Tightest limit.** One per action, ~200/game, so ~500 games/day. See §5.5 |
| SQL rows read | 5,000,000 | Irrelevant at this scale |
| Storage | 5 GB total | Irrelevant; finished rooms are deleted |
| Static assets | unlimited, free | The entire frontend |

Outbound WebSocket messages are not billed at all, nor are protocol pings — exactly the
shape of this game (few inbound actions, many outbound broadcasts).

`*.workers.dev` is free; a custom domain is optional.

### Why not Next.js / SSR

The Workers free plan caps a Worker bundle at 3 MiB and dynamic requests at 100k/day with
10 ms CPU each. Next.js via OpenNext fits that badly. This app is a WebSocket-driven SPA
with no SEO surface and no server-rendered content, so SSR buys nothing. A static build
served from Workers Static Assets is free and unlimited, and never touches the request cap.

---

## 4. Repository layout

As built through phase 3. Items marked `(phase N)` do not exist yet.

```
mythical-runner/
  packages/engine/          # pure TS, zero runtime deps, the entire game
    src/
      ids.ts                # branded PlayerId / RacerId / RoomCode / ChoiceId
      rng.ts                # splitmix32 PRNG derived from (seed, step)
      state.ts              # GameState, Phase, RacerState, PendingDecision, PlayerView
      actions.ts            # discriminated union of every Action
      events.ts             # discriminated union of every Event (drives UI)
      scoring.ts            # Token, RACE_AWARDS
      errors.ts             # IllegalActionError, EngineError, invariant
      redact.ts             # GameState -> PlayerView
      protocol.ts           # wire message types, shared by server and client
      globals.d.ts          # structuredClone / console / process declarations
      jobs.ts               # Job union — a turn as serializable data
      tracks/               # types.ts, mildMile.ts, wildWilds.ts, index.ts
      characters/
        types.ts            # RacerDef
        hooks.ts            # HookCtx and the Hooks interface
        registry.ts         # roster; 9 real racers + vanilla padding
        defs/index.ts       # the nine implemented racers
      reducer/
        index.ts            # initGame, applyAction, legalActions, timeout
        working.ts          # DeepMutable working copy + lookup helpers
        lobby.ts            # join / leave / start
        draft.ts            # roll-off and snake draft
        commit.ts           # secret selection and reveal
        racing.ts           # turn loop, finish detection, cup awards
        pipeline.ts         # job queue, hook dispatch, pending decisions
      dev/
        hotseat.ts          # scripted full game + replay check
        fuzz.ts             # randomised games, crash and determinism hunt
        scenarios.ts        # per-racer ability tests
  apps/server/              # Cloudflare Worker + RoomDO
    wrangler.jsonc          # DO binding, new_sqlite_classes migration
    src/
      index.ts              # Worker router
      room.ts               # RoomDO: auth, hibernation, persistence, alarm
      auth.ts               # credential validation, secret hashing
      codes.ts              # join code generation
      env.ts                # bindings
    test/
      e2e.mjs               # real WebSocket clients against wrangler dev
  apps/web/                 # Vite + React SPA
    src/
      main.tsx, App.tsx     # entry, two-route router
      styles.css            # tokens (light + dark), mobile-first layout
      lib/
        roomClient.ts       # WebSocket store: reconnect, events delivered exactly once
        roomContext.ts      # connection shared with every screen; legalOf()
        useBoardPositions.ts  # replays moves one hop at a time, resyncs to truth
        useEventLog.ts      # race log built from events
        present.ts          # names, seat colours, "waiting on", event -> log line
        identity.ts, api.ts, router.ts
      components/
        Board.tsx           # SVG snake track
        bits.tsx            # tokens, racer cards, standings, countdown, action bar
      screens/              # Home, Room, Lobby, Draft, Commit, Race, Results, GameOver
    test/
      ui.mjs                # plays a full game through the UI on phone-sized screens
  docs/
```

**npm workspaces** (pnpm is not installed on this machine; npm 10 workspaces are
equivalent for this purpose). `engine` depends on neither app; both apps depend on `engine`.

---

## 5. Architecture

### 5.1 Engine — the whole game as a pure function

No I/O, no React, no network.

```ts
initGame(seed: number): GameState
applyAction(state: GameState, action: Action): { state, events[] }
legalActions(state, playerId): Action[]
redact(state, playerId): PlayerView   // strips seed, commits, pending context
```

Seeded RNG, so any game is a replayable list of `(seed, actions[])`. This is what makes the
thing testable, and what lets the client predict moves locally.

> **Changed in phase 1.** This section originally sketched
> `applyAction(state, action, rng)`. The RNG is now derived internally from
> `(state.seed, state.step)` and the parameter is gone. A caller advancing the stream out
> of lockstep with `step` would desync replays in a way that is extremely hard to debug;
> deriving it internally makes that mistake unrepresentable. Verified by the fuzzer: every
> game's action log replays to a byte-identical final state.

`applyAction` throws `IllegalActionError` without mutating anything — application is
all-or-nothing, so a rejected message leaves the room untouched.

### 5.2 Core types

As implemented — see [state.ts](../packages/engine/src/state.ts) for the authoritative
version with full comments.

```ts
type Phase =
  | { t: 'lobby' }
  | { t: 'draftRoll'; rolls: Record<PlayerId, number | null> }
  | { t: 'draft'; deck: RacerId[]; layout: RacerId[]; order: PlayerId[]; pick: number }
  | { t: 'commit'; raceNo: 1|2|3|4; committed: Record<PlayerId, RacerId | null> }
  | { t: 'racing'; raceNo: 1|2|3|4; active: PlayerId; finished: PlayerId[]
      stalledTurns: number; claimedSpaces: number[] }
  | { t: 'scored'; raceNo: 1|2|3|4 }
  | { t: 'gameOver'; winners: PlayerId[] }

type RacerState = {
  owner: PlayerId
  racerId: RacerId
  pos: number                     // -1 = start space, 30 = finished
  tripped: boolean
  eliminated: boolean
  finishedRank: number | null
  memo: Record<string, unknown>   // per-character scratch space
}

type GameState = {
  seed: number; step: number      // rng derived from (seed, step)
  players: Player[]               // id, name, connected
  seatOrder: PlayerId[]
  hands: Record<PlayerId, RacerId[]>   // drafted, public
  used: Record<PlayerId, RacerId[]>
  scores: Record<PlayerId, Token[]>
  starSupply: Record<1 | 3, number>
  phase: Phase
  board: RacerState[]
  pending: PendingDecision | null
  deadline: number | null
}
```

Three additions phase 1 forced that the original sketch did not have:

- **`draftRoll` is its own phase.** The roll-off for draft order has real state (who has
  rolled, who must re-roll after a tie) and could not be folded into `draft`.
- **`claimedSpaces`** tracks which star spaces have been looted this race. Supply alone is
  not enough: a racer bounced back and forth across a star space by Wild Wilds arrows would
  otherwise farm it indefinitely.
- **`stalledTurns`** counts consecutive turns with no forward progress. It is unreachable
  today — every roll advances someone — but phase 2's blockers and backward movement can
  genuinely deadlock a race, and hitting that as an infinite loop in production is worse
  than capping it now.

`deadline` is a wall-clock timestamp owned by the server, not the engine. The engine only
re-validates it when handling `system/timeout`.

`pending` is the linchpin. When a handler needs input it returns one, `applyAction` parks,
and the only legal action in the game becomes that player's response. Duelist, Centaur's
kick target, and every "may" ability route through it.

### 5.3 The ability pipeline

35 rule-breaking powers will destroy the codebase if written as
`if (character === 'banana')` inside the move function. Use an event pipeline instead —
characters register handlers on hooks.

Resolution order within a turn:

`onTurnStart → replaceRoll → modifyRoll → beforeMove → [per step: onPassOver, onEnterSpace] → onLandOn → onOtherEntersMySpace → onTurnEnd`

Out-of-band: `onRaceStart`, `onPassedBy`, `onAnyoneFinishes`, `onScoring`.

```ts
type Character = {
  id: RacerId
  name: string
  text: string                     // rules text shown in UI
  hooks: Partial<Record<Hook, Handler>>
}
type Handler = (ctx: Ctx) => HookResult   // mutate via ctx helpers, or return a PendingDecision
```

Three rules that prevent rewrites:

1. **Movement is one space at a time.** A loop firing `onPassOver` per intermediate space and
   `onEnterSpace` on arrival. Forced and backward movement use the same loop. Banana,
   blockers and Wild Wilds arrows then fall out for free.
2. **Handlers never mutate state directly** — they emit intents (`move`, `trip`, `award`,
   `eliminate`) which the engine applies. Ordering stays deterministic and the event log
   becomes a complete replay.
3. **Every handler is resumable.** Returning a `PendingDecision` stores a continuation key in
   `memo`; on resume the handler is re-entered with the answer. Do not use JS generators
   across a serialization boundary — the DO hibernates.

Characters live as data (`characters/banana.ts` exporting metadata + handlers), never a
switch statement.

### 5.4 Server — Worker + Durable Object

As built in phase 3. Code in [apps/server/src](../apps/server/src).

**The Worker** ([index.ts](../apps/server/src/index.ts)) is a thin router. The room code *is*
the Durable Object's name, so every Worker instance routes a code to the same object with no
lookup table.

| Route | Does |
|-|-|
| `POST /api/rooms` | Mints a 4-char code, calls `init()` on that object. Body: `{ turnSeconds? }` |
| `GET /api/rooms/:code` | Room info for the join screen: exists, phase, player count, joinable |
| `GET /api/rooms/:code/ws` | WebSocket upgrade, forwarded to the room |
| `GET /api/health` | Liveness |

Codes use an alphabet without 0/O/1/I, since they are read aloud and typed on phones.
`init()` refuses an object that already holds a room, which is how a code collision surfaces;
the Worker retries with a fresh code.

**The Durable Object** ([room.ts](../apps/server/src/room.ts)), one per room, is the sole
authority. Durable Objects are single-threaded, so two players acting at once simply queue —
there is no concurrency control to write.

- Every inbound message: stamp `by` from the **authenticated socket** (never from the
  message) → `applyAction` → persist → send each socket `redact(state, itsPlayer)`.
- Clients may only send the eight gameplay action types in `CLIENT_ACTION_TYPES`.
  `lobby/join` and `lobby/setConnected` are dispatched by the server as sockets open and
  close; `system/timeout` only ever comes from the alarm. Accepting those from a client would
  let a player impersonate the clock.
- **The client never receives the seed**, the job queue, or suspended-power continuations.
  The e2e test asserts all three against raw wire bytes.
- **WebSocket Hibernation API** — `acceptWebSocket()` and the `webSocketMessage` /
  `webSocketClose` handlers. Instance fields do not survive hibernation, so the constructor
  reloads from storage under `blockConcurrencyWhile`, and per-socket identity lives in the
  socket's serialized attachment rather than a Map. Sockets are tagged with their player id,
  so one player may have several tabs open; closing one tab does not disconnect them.
- `compatibility_date` is 2026-09-01, which is at or after 2026-04-07 and so enables
  `web_socket_auto_reply_to_close`: the runtime completes the close handshake itself.

**Messages** ([protocol.ts](../packages/engine/src/protocol.ts)). Every server message to a
player is a full `state` snapshot: their redacted view, the events the last action produced,
and — importantly — **`legal`, the actions that player may take right now, computed
server-side.** The client renders its buttons from `legal` rather than re-deriving
legality, so there is exactly one implementation of the rules deciding what is allowed.

This replaced a plan to let the client call `legalActions` itself, which turned out not to
work: `legalActions` needs the full `GameState`, and a client only ever has a `PlayerView`
with the commit phase masked.

**Reconnect** ships a full snapshot rather than replaying missed events. Always correct,
far simpler, and the cost is only that a returning client snaps to the current position
instead of animating what it missed.

**Rejected connections** are accepted, sent an `error` message, then closed with a 4xxx code
(4000 bad request, 4001 bad credentials, 4003 full or in progress, 4004 no such room). A
browser's WebSocket API cannot read the HTTP status of a failed upgrade, but it can read a
close code.

**Turn clock and expiry** share the one alarm a Durable Object gets:

- The deadline resets on every gameplay action, but **not** on connect/disconnect
  bookkeeping, so a flapping connection cannot buy extra time. A reconnect mid-game *does*
  reset it, so a player returning to a nearly-expired turn gets a fair chance.
- When the alarm fires it dispatches `system/timeout`, which the engine already handles for
  every phase — auto-roll, auto-commit, auto-pick, auto-answer a pending decision.
- **An empty room does not auto-play.** If nobody is connected the clock waits rather than
  playing the game to its end unwatched.
- When the last socket leaves, the room is marked to expire in 6 hours. Rejoining cancels it;
  otherwise the alarm deletes all storage, which frees the code.
- A timeout that throws is an engine bug. The deadline is cleared rather than letting the
  alarm retry into the same exception forever.

`turnSeconds` is set at room creation: 0 disables the clock, otherwise clamped to 15–600,
default 60.

### 5.5 Persistence

**Written once per action — not debounced.** This reverses the original plan, which called
for holding state in memory and snapshotting on a ~2 s timer. That was wrong twice over:

- **A pending `setTimeout` prevents hibernation.** The Cloudflare docs are explicit. A
  debounce timer would keep the object awake — and billed — for two seconds after every
  single move, defeating the point of hibernating at all. (An earlier version of this section
  claimed the debounce was "exactly what hibernation-safety requires". It is the opposite.)
- **Eviction during the debounce window loses moves clients have already seen.** Every
  client would then hold a state the server no longer agrees with.

Per-action writes are correct under both. Durable Objects' output gate holds outgoing
messages until the write commits, so a client never sees a state that was not persisted.

The budget still holds comfortably: a game is ~200 actions, each one row write, so the
100,000/day free allowance covers roughly **500 games a day**.

| Key | Contents | Written |
|-|-|-|
| `meta` | code, createdAt, turnSeconds | once, at creation |
| `state` | `GameState` | every action |
| `secrets` | playerId to SHA-256 of their secret | when a new player registers |
| `expiresAt` | timestamp | when the room empties |

Verified by killing the runtime process mid-game — in race 2, with race 1's scores already
awarded — restarting it cold, and reconnecting: phase, active player, scores, used racers
and every board position came back exactly, and the restored game played to the end.

### 5.6 Identity

No accounts. On first joining a room, the browser generates a random `playerId` and
`secret` and keeps them in localStorage. The room stores a **SHA-256 of the secret** on first
use and requires the same secret on every reconnect.

`playerId` is public — it appears in every broadcast — so it cannot be what proves identity.
The secret is what stops one player submitting turns as another.

Credentials travel in the upgrade URL's query string. Acceptable for a friends' game, but
they will appear in any access log that records full URLs. The alternative — authenticating
in a first message — needs an unauthenticated-socket state with its own timeout, which is
more machinery than the threat justifies here.

### 5.7 Redaction

Only one secret exists, but it matters: during `commit`, each player's chosen racer.
`redact` replaces other players' entries with `'hidden' | null`.

Write `redact` in phase 1 even though it is nearly a no-op then. Retrofitting it later means
auditing every payload.

### 5.8 Client

As built in phase 4. Code in [apps/web/src](../apps/web/src). Vite + React + TypeScript,
built to static files and served by the same Worker as the API.

**One connection, one store.** [roomClient.ts](../apps/web/src/lib/roomClient.ts) is a plain
external store read through `useSyncExternalStore`, not React state. Two reasons: the
socket's lifetime should not follow render cycles, and events must reach listeners exactly
once and in order. Held in React state, two messages landing in one tick get batched and the
first message's events are silently lost — and with them, the animation.

It reconnects with backoff, treats the 4xxx close codes as final, hides stale-click
rejections (normal in live multiplayer), and blocks controls between sending an action and
hearing back, so a double tap cannot send a move twice.

**Buttons come from `legal`.** Every control is enabled from the server-computed `legal`
list and sends the entry back unchanged. The client never works out for itself what is
allowed.

**Anything that reads events lives above the phase switch.** Both the race log and the board
animation subscribe for the life of the connection rather than inside the race screen. This
was found by building it wrong first: the message that *switches* screens is the one carrying
"race begins", the reveals and who goes first, and a screen subscribing on mount is always
one message late.

The same cause had a second symptom. The move that decides a race arrives in the same
message that ends it, so going straight to results meant **nobody ever saw the winner cross
the line**. When racing turns to scored, the race screen now stays up until the board has
finished animating, then 1.6 s longer.

**Animation replays events, then resyncs to truth.** `racer/moved` plays one hop per ~170 ms,
faster when a burst of powers backs up. `racer/warped` snaps instead of hopping, because a
warp "doesn't count as moving". When the queue empties, drawn positions reset to the real
board. That catches relocations that deliberately emit no event (Huge Baby) and reconnect
snapshots. `prefers-reduced-motion` skips the replay. The list of racers follows the
*drawn* positions too, so it never says "1st" while the winner is still visibly mid-track.

**Screens**, one per phase, each with a sticky action bar at thumb height:

| Screen | Notes |
|-|-|
| Home | Name, turn timer (off / 30 s / 60 s / 2 min), create, or join by code |
| Room gate | Checks the room over HTTP *before* opening a socket, since a browser cannot read why an upgrade failed. Auto-joins only with a name saved *before* arriving |
| Lobby | Big room code, share sheet or copy link, seats with host and away tags |
| Draft | Roll-off dice, then the face-up layout with full power text, your team, and every team |
| Commit | Two taps — select, then lock in — because the choice is irrevocable and a stray tap while scrolling should not spend a racer |
| Race | SVG board, racers with full power text, event log, standings; decisions appear in the action bar |
| Results | Podium with cup values, points this race, standings |
| Game over | Winner or tie, per-race breakdown |

**The board** ([Board.tsx](../apps/web/src/components/Board.tsx)) is a 6 × 5 snake, so thirty
spaces fit a phone held upright, with a line through the space centres showing the direction
of travel. Tokens are sized by how crowded a space is — one racer gets nearly the whole
space, six share it — because at phone width a space is only about 45 px across.

**Colour and legibility.** Light and dark themes from `prefers-color-scheme`. Six seat
colours chosen to stay distinguishable in both themes; every token also carries initials, so
colour is never the only cue. Placeholder racers show their number instead of initials,
since "Racer 13" and "Racer 15" would otherwise both read "R1".

**Card text is never hidden.** It is on every racer card in the draft, commit and race
screens. With thirty-six rule-breaking powers, not being able to see what a racer does is
the single easiest way for this game to become unplayable.

---

## 6. Build phases

| # | Deliverable | Gate | Status |
|-|-|-|-|
| 0 | Types, both 30-space tracks as data, seeded RNG, action/event unions | `npm run typecheck` clean | **done** |
| 1 | Engine core, **no abilities**: draft, commit, turn loop, movement, trip/stand-up, top-2 finish, token scoring, 4-race loop | Hot-seat CLI plays a full 4-race game | **done** |
| 2 | Hook pipeline + pending decisions + 9 racers covering every hook type (incl. Duelist for the interactive case) | Scripted scenario test per racer passes | **done** |
| 3 | Worker + RoomDO: create/join, WS, authority, redaction, reconnect, alarm timer | Two browsers play a full game | **done** |
| 4 | Web client end to end, SVG board, animation queue, mobile layout | Playable on a phone | **done** |
| 5 | Remaining 27 racers — card text is available, so this is data entry | Each racer has a scenario test | next |
| 6 | Spectators, replay viewer, fill bots, sound | — | |

Phases 1–2 are the real work. Phase 5 should be cheap if phase 2 is designed correctly.

### Phase 0 — delivered

Identifiers, `makeRng(seed, step)`, both tracks as data, scoring tables, the state shape,
and the action (11 members) and event (22 members) unions.

### Phase 1 — delivered

The reducer. A complete game runs end to end: roll-off → snake draft → secret commit →
race → scoring → next race → game over.

Run it:

```
npm run typecheck          # whole workspace
npm test                   # 1000 fuzzed games
npm run hotseat -w @mr/engine -- 20260916 4    # one narrated game
npm run fuzz    -w @mr/engine -- 2000 1        # crash + determinism sweep
```

Two harnesses live in `packages/engine/src/dev/`:

- **hotseat** plays a scripted game and then re-applies the recorded action log to a fresh
  `initGame(seed)`, asserting the final states are byte-identical. This is the replay
  guarantee the whole architecture rests on.
- **fuzz** plays randomised legal games at 2–6 players, hunting crashes, non-termination
  and replay mismatches, and reporting the win distribution by seat.

Latest: 1500 games, 0 failures, 0 replay mismatches, 0 stalemates, ~202 actions/game.

### Phase 2 — delivered

The ability pipeline, plus seven racers chosen to hit every hook between them: Legs
(`replaceRoll`), Banana (`onPassOver` / `onOtherEntersMySpace`), Big Baby
(`blocksMovement`), M.O.U.T.H. (elimination on arrival), Lovable Loser (`onTurnStart`
scoring), Centaur (an optional choice by the active player), and Duelist (a choice
demanded of a player who is *not* taking the turn).

**A turn is a job queue, not a call stack.** This is the one structural decision phase 2
turned on. An ability can suspend mid-movement to ask someone a question, and the answer
may not arrive for minutes — during which the Durable Object hibernates and the JS call
stack ceases to exist. So `GameState.queue` holds the turn as plain serializable data; the
engine drains it, suspending simply means stopping with jobs still in it, and a
half-finished six-space move survives as a `move` job with `remaining` counted down.

Two things that had to be got right, both found by tracing the resume path rather than by
a test:

- **Jobs are popped before they run, not peeked.** An earlier version retired a job only
  if nothing had been pushed in front of it. That meant a job which suspended stayed at
  the head and re-ran on resume — Centaur would re-ask its question forever.
- **The continuation lives on `pending.resume`, not in the queue.** During a suspension
  the queue holds only the interrupted work, so the interrupted job re-queues itself
  normally without having to reason about where a resume job might already be sitting.
  `answerPending` then unshifts the resume job in front of it.

Verified across 800 fuzzed games: every ability fires, every branch is reached (duel won,
lost and drawn; kick accepted and declined), 2375 decisions were raised and answered, and
the queue drained to empty at the end of every single game. A scenario test asserts that a
suspended turn survives a JSON round trip and resumes identically — the hibernation case,
tested directly.

### Phase 3 — delivered

The server. A room is a Durable Object; players connect over WebSockets and play a full game.

The gate was "two browsers play a full game", but there is no browser client until phase 4.
So [e2e.mjs](../apps/server/test/e2e.mjs) drives **real WebSocket clients over the exact
protocol a browser will use**, against the real Worker and Durable Object running in workerd
via `wrangler dev`. It imports nothing from the engine — it knows only what a client knows.

38 checks across six scenarios:

| Scenario | Proves |
|-|-|
| Four clients play a full game | ~190 steps in 2–3 s; all clients end on the same step with the same scores; the seed, job queue and continuations never appear in raw wire bytes |
| Commit secrecy | B sees *that* A committed but nothing reveals *which* racer; no event is emitted |
| Credentials and limits | Wrong secret 4001, no room 4004, malformed 4000, seventh player 4003, joining a game in progress 4003 |
| Impersonation | A client-supplied `by` is ignored; `system/timeout` and `lobby/join` are refused; malformed JSON is rejected without killing the socket |
| Reconnect | Drop mid-race and return to the same seat and live game; closing a second tab does not disconnect the player |
| Turn clock | An idle player's turn is auto-rolled by the alarm after ~15 s |

Plus the cold-restart persistence test described in §5.5.

Two things phase 3 turned up that were not in the plan:

- **A commit-secrecy failure that was not a leak.** The first version asserted A's racer id
  appeared nowhere in B's frame, and it failed. The id was in `hands` — A's drafted team,
  which is public by design because the draft is face-up. The assertion was tightened to
  what actually matters: nothing *outside* the public hands reveals which of them A chose.
- **Stopping `wrangler dev` on Windows leaves `workerd` running.** The first attempt at the
  restart test would have "passed" against the still-running old process with the room still
  in memory. See the traps section of [STATUS.md](./STATUS.md).

### Phase 4 — delivered

The web client. A complete game is playable in a browser on a phone.

**Verified by playing it through the UI.** [ui.mjs](../apps/web/test/ui.mjs) drives an
installed Chrome as three people on 390 × 844 phone screens, one in dark mode. The host
creates a room from the home page, two friends join from the link, and everyone taps
whatever the UI offers until the game ends — no API calls, no state injection. It
screenshots each phase and checks that the game reaches game over for every player, that all
clients agree on the scores, and that there are no page errors, console errors, or horizontal
overflow on any screen.

Every screenshot was reviewed by eye, not just asserted on. That review found what no check
would have:

| Found | Fix |
|-|-|
| Tokens about 9 px across on a phone — unreadable | Sized by how crowded the space is, up to nearly the whole space |
| "Racer 13" and "Racer 15" both labelled **R1** | Numbered racers show their number |
| Racers waiting on Start covered the START label | Moved to the corner, like space numbers |
| List said "1st" while the winner was still mid-track | List follows drawn positions |
| "A tie between **You** & Cy" | Lowercase mid-sentence |

Three more were found by driving it rather than by looking:

- **Typing a name joined the room after the first keystroke.** The auto-join read the live
  form field instead of a name saved before arriving, so "Bob" would be seated as "B". The
  UI test now types names a key at a time and fails if the room is joined early.
- **The race log and board animation missed the events that change screens** — see §5.8.
- **Nobody saw the winning move** — see §5.8.

### Rules rework (after the rulebook arrived)

The first pass at phase 2 was built from published reviews and got the three rules above
wrong, along with every one of the implemented racers. All of it has been corrected against
the rulebook:

- Per-step pass and occupancy triggers replaced with a `passCheck` job that runs once a move
  completes, comparing start and end positions.
- Trip no longer halts movement; the stand-up is handled inside the `mainMove` job so a
  tripped racer's other powers still fire.
- Huge Baby (previously "Big Baby") displaces a racer to the space behind rather than
  blocking movement — and explicitly without emitting a move, per the card.
- Centaur's hoofwhack is mandatory and fires on passing, not an optional kick.
- Duelist is the *Duelist's* choice, the winner advances 2, and it can fire on another
  player's turn.
- Point chips are a plain number. The 9 bronze 3-point chips are just change for three
  1-point chips, so there are no denominations and no supply to exhaust.
- Wild Wilds spaces are arrows (signed), TRIP spaces, and stars — not backward arrows.
- The Start space is index 0 and counts as a space, per the rules.

### Transcribed from the board

The **Wild Wilds space layout** in
[tracks/wildWilds.ts](../packages/engine/src/tracks/wildWilds.ts) is copied from a photo of
the printed board, since the rulebook documents the three space types but does not print
the board.

---

## 7. Testing

- **Golden replays** — *built (phase 1)*. A game is `(seed, Action[])`. The hotseat harness
  records one and re-applies it to a fresh `initGame(seed)`, asserting the final states
  match. Any engine change that breaks a replay is either a bug or an intentional rules
  change.
- **Fuzzer** — *built (phase 1)*. Random-legal games at 2–6 players, hunting crashes,
  non-termination and replay mismatches.
- **Scenario tests per racer** — *built (phase 2)*. Hand-constructed `GameState`, one
  action, assert the resulting events. Dice are forced by searching for a seed that
  produces the wanted roll, rather than by mocking the RNG — so the tests exercise the
  real engine.
- **Timeout fuzzing** — *built (phase 2)*. A third of fuzzed games fire `system/timeout` at
  random, exercising auto-rolls, auto-commits and auto-answered decisions.
- **Stalemate rule** — *built (phase 1)*, though unreachable until abilities exist. Blockers
  plus backward movement can genuinely deadlock a race; after
  `6 x playerCount` consecutive turns with no forward progress the race is called and
  whoever has already finished keeps their cups.

- **UI end-to-end** — *built (phase 4)*. `npm run test:ui -w @mr/web` against a running
  `npm run start`. A full game through the real UI on phone-sized screens, in both themes.
  Not part of `npm test`, because it needs a live server and a local Chrome.
- **End-to-end** — *built (phase 3)*. `npm run e2e -w @mr/server` against a running
  `npm run dev -w @mr/server`. Real WebSocket clients, real Durable Object. Not part of
  `npm test`, because it needs a live server; `--fast` skips the 15-second clock scenario.

The fuzzer also reports the win distribution by seat. That is a **bug detector, not a
balance metric** — a seat winning too rarely usually means it is being skipped, not that
the game is unfair. Balance is explicitly not a goal for this project.

---

## 8. Sources

- [BGG — Magical Athlete](https://boardgamegeek.com/boardgame/454103/magical-athlete)
- [GeekDad — Wacky Racing in Magical Athlete](https://geekdad.com/2025/11/wacky-racing-in-magical-athlete/)
- [Board Game Review](https://boardgamereview.co.uk/game-reviews/magical-athlete-board-game-review/)
- [Meeple Mountain](https://www.meeplemountain.com/reviews/magical-athlete/)
- [CMYK Games](https://www.cmyk.games/products/magical-athlete)
- [Durable Objects free tier changelog](https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
