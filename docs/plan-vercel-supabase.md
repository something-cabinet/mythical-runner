# Mythical Runner — Implementation Plan (Vercel + Supabase)

Not used.

Alternative to [plan-cloudflare.md](./plan-cloudflare.md). Same game, same engine, different
infrastructure. Written for side-by-side comparison — see §9.

- **Stack:** Next.js on Vercel Hobby · Supabase Postgres + Realtime · Supabase Realtime as transport
- **Cost:** $0/month, with one significant caveat (§3.3 — free projects pause after 7 days idle)
- **Status:** draft, not yet started

---

## 1. The source game

Identical to the Cloudflare plan. See [plan-cloudflare.md §1](./plan-cloudflare.md) for the
full rules table, the ~35 racers, the open dependency on card text, and the legal note.

Summary of what the infrastructure has to support:

- 2–6 players, four races, 30-space double-sided track
- Snake draft of 4 racers each
- **Simultaneous secret commit** before each race — the one piece of hidden information
- Turn-based d6 roll-and-move with ~35 rule-breaking abilities
- Interactive abilities that interrupt and require input from a *non-active* player
- Race ends when two racers finish; escalating trophy values across four races

---

## 2. Architecture

### 2.1 The key constraint

Vercel Functions cannot host a long-lived WebSocket for this game. WebSocket support exists
(public beta, runs on Fluid compute, idle time not billed), but a connection is bound by
`maxDuration`, and **Hobby caps that at 300 s**. A 30-minute game would force a reconnect
every five minutes. Pro's 800 s doesn't fix it either.

So Vercel does **not** carry realtime traffic. Clients connect **directly to Supabase
Realtime**, which is a genuine persistent WebSocket service with no duration cap. Vercel
handles page serving and the mutation API only.

### 2.2 The shape

```
Browser ──── HTTP POST /api/rooms/:code/action ────▶ Vercel Function (Next.js Route Handler)
   ▲                                                          │
   │                                                    reads + writes
   │                                                          ▼
   └──── WebSocket (persistent) ──── Supabase Realtime ◀── Supabase Postgres
```

Every action is a **write path** through Vercel and a **read path** through Supabase
Realtime. The two are decoupled: the function does not push to clients, it just commits the
new state and lets Postgres Changes fan it out.

### 2.3 Request flow for one turn

1. Client POSTs `{ action, playerId, token, version }` to the Route Handler.
2. Handler loads the room row, verifies the token, checks
   `legalActions(state, playerId)` contains the action.
3. Handler runs `applyAction(state, action, rng)` — the same pure engine.
4. Handler writes back with **optimistic concurrency**:
   `UPDATE rooms SET state = $1, version = version + 1 WHERE code = $2 AND version = $3`.
   Zero rows affected means someone raced you; reload and retry (bounded, 3 attempts).
5. Postgres Changes fires on the `rooms` row; every subscribed client receives the new
   public state and renders it.

Optimistic concurrency is not optional. Unlike a Durable Object, serverless functions have no
single-threaded guarantee — two players can submit simultaneously, and without the version
check one write silently clobbers the other.

---

## 3. Cost analysis — $0, with an asterisk

### 3.1 Vercel Hobby

| Limit | Free |
|-|-|
| Bandwidth | 100 GB/month |
| Functions | Free within plan limits; Fluid compute, active-CPU billing |
| Max function duration | 300 s (default and maximum) |
| Memory | 2 GB / 1 vCPU |
| Cron jobs | 100 per project, but **minimum cadence is once per day** |
| Commercial use | **Not permitted** — Hobby is personal, non-commercial only |

Fine for this project. The once-per-day cron minimum matters — see §4.3.

### 3.2 Supabase Free

| Limit | Free |
|-|-|
| Active projects | 2 |
| Database | 500 MB |
| Database egress | 5 GB/month |
| Realtime concurrent connections | 200 |
| Realtime messages | 2,000,000/month, 256 KB max message |
| Monthly active users (auth) | 50,000 |
| Edge function invocations | 500,000/month |

A 6-player game generates a few hundred realtime messages. 2M/month is not a constraint.
200 concurrent connections caps you at ~33 simultaneous 6-player games, which is far beyond
what this needs.

### 3.3 The asterisk: free projects pause

**Supabase pauses free projects after 7 days of inactivity.** The Postgres instance spins
down and the first request afterwards takes 10–30 seconds to cold-start.

For a game played occasionally with friends, this *will* happen. Mitigations:

- A once-daily Vercel cron hitting a trivial Route Handler that issues one query. This is
  exactly what the Hobby cron cadence is good for, and it costs nothing.
- Or a GitHub Actions scheduled workflow doing the same, which is more reliable than relying
  on Vercel cron timing (Hobby cron timing is only guaranteed within the hour).

Either works, but it is an ongoing piece of scaffolding that the Cloudflare design simply
does not need — a Durable Object has no concept of being paused.

### 3.4 Latency

Honest comparison: every action makes two network hops (browser → Vercel `iad1` → Supabase
region) plus a Postgres round trip, then fans back out through Realtime. Expect 150–400 ms
per action, with occasional function cold starts on top. The Durable Object design is a
single hop to state already resident in memory.

For a turn-based board game this is acceptable. It is not *good*, and it will be noticeable
when an ability chain resolves.

---

## 4. Implementation specifics

### 4.1 Database schema

The schema is designed so that **the one secret never lives in a realtime-published table**.
This replaces the `redact()` broadcast filtering the Cloudflare design uses.

```sql
create table rooms (
  code        text primary key,           -- 4-char join code
  version     int  not null default 0,    -- optimistic concurrency
  state       jsonb not null,             -- public GameState (no seed, no secret commits)
  seed        bigint not null,            -- server-only, never selected by clients
  deadline    timestamptz,                -- turn timer, see 4.3
  updated_at  timestamptz not null default now()
);

create table room_players (
  code       text references rooms(code) on delete cascade,
  player_id  text,
  token      text not null,               -- per-player secret, server-verified
  name       text,
  primary key (code, player_id)
);

-- SECRET. Never added to the realtime publication.
create table race_commits (
  code       text references rooms(code) on delete cascade,
  race_no    int,
  player_id  text,
  racer_id   text not null,
  primary key (code, race_no, player_id)
);
```

Realtime publication includes **`rooms` only**. `race_commits` and the `seed` and `token`
columns are never fanned out.

RLS: deny-all to the anon key on every table. All reads and writes go through the Route
Handler using the service-role key. Clients get state exclusively via Realtime. This is
simpler and tighter than trying to express the game's legality rules as RLS policies.

The commit flow then becomes: each player POSTs their choice, the handler inserts into
`race_commits` and bumps `rooms.version` with a "3 of 5 committed" counter in public state.
When the last commit lands, the handler reads all rows and writes the revealed selections
into `rooms.state` in the same transaction.

### 4.2 Realtime transport

Use **Postgres Changes** subscribed to the `rooms` row for this room:

```ts
supabase.channel(`room:${code}`)
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${code}` },
      ({ new: row }) => store.apply(row.state, row.version))
  .subscribe()
```

Because `rooms.state` contains only public information by construction, there is no
per-player filtering to do and no way to leak a secret through a misconfigured payload.

> **Alternative considered:** Supabase Broadcast with private channels and Realtime
> Authorization (RLS on `realtime.messages`), which would allow genuinely per-player payloads
> and match `redact()` exactly. It requires each player to hold a real JWT — feasible via
> Supabase anonymous sign-ins, which cost nothing against the 50k MAU allowance. Rejected as
> the default because the two-table split achieves the same security property with far less
> machinery. Worth revisiting only if a future racer ability introduces per-player hidden
> state.

### 4.3 Turn timers — the awkward part

There is no server-side alarm. Vercel Hobby cron cannot fire more than once a day, and
Supabase's `pg_cron` is a poor fit for per-room deadlines.

Solution: **client-driven expiry with server-side validation.**

- `rooms.deadline` is set by the handler whenever the active player changes.
- All clients render a countdown from `deadline`. When it passes, any client may POST
  `/api/rooms/:code/force-advance`.
- The handler validates `now() > deadline` against the database before doing anything, then
  auto-rolls for the active player and resolves any `pending` decision.

This is safe — a client cannot advance early, because the deadline is server-held and
server-checked. It fails only if *every* client has the tab closed, in which case nobody
cares. It costs nothing and needs no scheduler.

### 4.4 Reconnection

On mount (or on Realtime resubscribe after a drop), the client GETs
`/api/rooms/:code/state`, which returns the current public state and version. The Realtime
subscription then keeps it current. Simpler than the Cloudflare event-replay design because
the client only ever renders whole states — but consequently the client cannot animate the
*steps* it missed, only snap to the result.

### 4.5 Animation caveat

Postgres Changes ships the new row, not an event list. To keep the "one hop per 180 ms"
animation from the Cloudflare plan, the handler must also write the events it produced into
`state.recentEvents` (bounded, say last 40), and clients animate from that, keyed by
`version` so a reconnecting client can skip stale animations.

This works, but it is meaningfully clunkier than a dedicated event stream, and it inflates
every row update.

---

## 5. Repository layout

```
mythical-runner/
  packages/engine/        # UNCHANGED from the Cloudflare plan — pure TS, zero deps
  apps/web/               # Next.js App Router (pages + Route Handlers, one deployment)
    app/
      page.tsx                        # create / join room
      r/[code]/page.tsx               # the game
      api/rooms/route.ts              # POST create
      api/rooms/[code]/join/route.ts
      api/rooms/[code]/action/route.ts
      api/rooms/[code]/state/route.ts
      api/rooms/[code]/force-advance/route.ts
      api/keepalive/route.ts          # daily cron target, see 3.3
  supabase/migrations/
  docs/
```

Single Vercel deployment; no separate server app. This is the one place the Vercel design is
genuinely simpler than Cloudflare's two-app split.

---

## 6. Engine

**Completely unchanged.** `packages/engine` has no dependency on either platform — that is
the entire point of keeping it a pure function. See
[plan-cloudflare.md §5.1–5.3](./plan-cloudflare.md) for `applyAction` / `legalActions` /
`redact`, the core types, the hook pipeline, pending decisions, and the three design rules
(step-by-step movement, intent emission, resumable handlers).

Two platform notes:

- The engine must be importable in the Node.js serverless runtime. It already is — zero deps.
- `redact()` is still worth implementing, and is used by `/api/rooms/[code]/state`. It is
  just no longer the primary secrecy mechanism; the schema split is.

---

## 7. Build phases

| # | Deliverable | Gate |
|-|-|-|
| 0 | Types, both tracks as data, seeded RNG, action/event unions | `pnpm typecheck` clean |
| 1 | Engine core, **no abilities** | Hot-seat CLI plays a full 4-race game |
| 2 | Hook pipeline + pending decisions + ~6 racers covering every hook type | Scenario test per racer |
| 3 | Supabase schema + migrations, Route Handlers, optimistic concurrency, Realtime subscription | Two browsers play a full game |
| 4 | Web client end to end, SVG board, animation from `recentEvents`, mobile layout | Playable on a phone |
| 5 | Remaining ~29 racers — **blocked on card text** | Scenario test per racer |
| 6 | Keepalive cron, spectators, replay viewer, fill bots, stalemate rule | — |

Phases 0–2 and 5 are byte-for-byte identical to the Cloudflare plan. Only phase 3 differs,
and phase 4 differs slightly (animation source).

---

## 8. Testing

Identical to the Cloudflare plan: golden replays, per-racer scenario tests, and a fuzzer
hunting crashes and non-terminating races. See
[plan-cloudflare.md §7](./plan-cloudflare.md).

One addition specific to this design: a **concurrency test** that fires two simultaneous
valid actions at `/api/rooms/:code/action` and asserts exactly one wins and the other
retries cleanly. The Durable Object design gets this for free; here it is real logic that can
regress.

---

## 9. Comparison with the Cloudflare plan

| | Cloudflare | Vercel + Supabase |
|-|-|-|
| Monthly cost | $0 | $0 |
| Overage risk | None — hard limits, operations fail | None on either free tier |
| Idle behaviour | DO hibernates, wakes instantly | **Project pauses after 7 days; 10–30 s cold start.** Needs a keepalive cron |
| Action latency | One hop, state in memory (~30–60 ms) | Two hops + Postgres round trip (~150–400 ms), plus cold starts |
| Concurrency | Single-threaded object; impossible by construction | Optimistic concurrency with version column; real logic that can regress |
| Secrecy model | `redact()` per-player broadcast | Schema split — secrets in a non-published table |
| Event stream / animation | Native; server pushes `events[]` | Piggybacked in `state.recentEvents`; clunkier |
| Turn timers | `storage.setAlarm()`, native | Client-triggered, server-validated deadline |
| Deployments | Two apps (static SPA + Worker) | One (Next.js) |
| Local dev | `wrangler dev` — full DO emulation | `next dev` + Supabase CLI, or a hosted dev project |
| Familiarity | Newer mental model (DOs, hibernation) | Conventional; most tutorials assume it |
| Vendor lock-in | DO API is Cloudflare-specific | Postgres is portable; Realtime is not |

**Where each wins.** Vercel + Supabase is more conventional, is one deployment instead of
two, and gives you a real Postgres you could reuse for anything else. Cloudflare is
materially better suited to *this specific problem* — a room is a single-threaded stateful
object with a timer, which is precisely what a Durable Object is, and the concurrency,
timer, secrecy and animation problems that need explicit engineering here all dissolve.

The engine — the actual hard work, phases 0–2 and 5 — is identical either way. That is
deliberate: the platform decision is reversible, and picking wrong costs you phase 3, not the
project.

---

## 10. Sources

- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Vercel WebSocket support (public beta)](https://vercel.com/changelog/websocket-support-is-now-in-public-beta)
- [Vercel cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Supabase — subscribing to database changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
- [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- Game rules sources: see [plan-cloudflare.md §8](./plan-cloudflare.md)
