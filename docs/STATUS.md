# Status & Handoff

**Last updated:** 2026-09-17 · **Phases 0–5 complete — all 36 racers playable. Phase 6 next.**

Start here when picking this project back up. It is written to be read cold, without the
conversation that produced it.

---

## 1. What this is

A web implementation of *Magical Athlete* (CMYK 2025 edition): room-based, multiplayer,
turn-based, running at **$0/month** on Cloudflare's free tier.

| Document | Role |
|-|-|
| [magical-athlete-rules.md](./magical-athlete-rules.md) | **The rules authority.** Full rulebook, all 36 racers. Where the engine disagrees with this, the engine is wrong |
| [plan-cloudflare.md](./plan-cloudflare.md) | The implementation plan. §5.4–5.8 describe the server and client *as built* |
| [plan-vercel-supabase.md](./plan-vercel-supabase.md) | Rejected alternative, kept for comparison. Marked "Not used" |
| `How-to-play-MAGICAL-ATHLETE_compressed.pdf` | Source PDF the rules came from |

Stack: **Vite + React + TypeScript (static)** and a **Cloudflare Worker + Durable Object** per
room over WebSockets. One Worker serves both, from one origin.

---

## 2. Where things stand

```
packages/engine/     COMPLETE — the whole game as a pure function, no runtime dependencies
apps/server/         COMPLETE — Worker + RoomDO; also serves the web app's static files
apps/web/            COMPLETE — the playable client, mobile-first, light and dark
```

A full game is playable in a browser. **Nothing has been deployed** — everything has only run
locally. All 36 racers have their real powers.

### Run it

```bash
npm install
npm run start        # builds the web app, then serves app + API at http://127.0.0.1:8787
```

Open that URL in a few browser windows to play.

**On real phones:** the dev server binds to `127.0.0.1` only, so other devices cannot reach
it. That default is deliberate. To play across a home network, build and serve on all
interfaces instead — `npm run build -w @mr/web`, then from `apps/server`,
`npx wrangler dev --ip 0.0.0.0` — and open `http://<this machine's LAN IP>:8787` on each
phone. That exposes the server to everything on the network, and Windows will likely ask to
allow it through the firewall. Not yet tried on physical phones; the phone checks so far are
phone-sized browser windows.

**Frontend work with hot reload:** run `npm run dev:server` and `npm run dev:web` together and
open http://localhost:5173. Vite proxies `/api`, WebSockets included, to wrangler — verified
with a full room join through the proxy.

### Verify it still works

```bash
npm run typecheck                    # all three workspaces
npm test                             # engine: 156 scenario checks + 1000 fuzzed games

# these need `npm run start` running in another terminal
npm run e2e -w @mr/server            # 50 checks over real WebSockets, a few minutes
npm run e2e -w @mr/server -- --fast  # skips the clock and bot scenarios
npm run test:ui -w @mr/web           # a full game through the UI on phone-sized screens
```

Last run: **engine 51/51 + 1000 games; server e2e 38/38; UI test passed** — full game, three
players, both themes, no errors, no overflow, clients agree. Screenshots land in
`apps/web/test/screenshots/` (gitignored) and are worth opening after any UI change.

### Git

Branch `main`, tracking `origin/main` on GitHub. Last commit `cb4d976` (phase 3), pushed.
**Phase 4 is uncommitted.** npm workspaces, not pnpm.

---

## 3. Decisions that are load-bearing

Do not re-litigate these without reading the reasoning. Each was arrived at by hitting the
problem, not by preference.

### Engine

**A pure function** — `initGame`, `applyAction(state, action)`, `legalActions`, `redact`.
No RNG parameter: randomness derives from `(seed, step)`, so every game replays
byte-identically from its action log.

**A turn is a job queue, not a call stack**, because a power can suspend mid-move to ask a
player something and the Durable Object may hibernate before they answer. Jobs are popped
before they run; the continuation lives on `pending.resume`.

**Three rules the pipeline is shaped around**, all got wrong on a first pass: passing is judged
after the whole move; tripping doesn't end the current move; sharing a space requires both
racers to be stopped there.

**Other settled points:** `START = 0`; points are a plain number; race 1 turn order by
roll-off, races 2–4 by farthest-behind; warps are not moves; **balance is not a goal**.

**Powers write prompts with `h.nameOf(racer)`**, never by interpolating `racerId` — players
read these.

### Server

**Persistence is per action, not debounced.** A pending `setTimeout` prevents hibernation, and
eviction mid-debounce loses moves clients already saw. ~500 games/day still fit the free
budget. Don't "optimise" this.

**The server tells each client what it may do** via `legal` in every state message.
**`by` is stamped from the authenticated socket**, never read from the message.

**Identity is trust-on-first-use** — random `playerId` + `secret` per room in localStorage,
SHA-256 of the secret stored server-side. **Rejections are close codes** 4000/4001/4003/4004.
**An empty room pauses its clock** and deletes itself 6 hours after the last player leaves.

### Client

**Buttons are enabled from `legal` and send the entry back unchanged.** The client must never
call `legalActions` — it only has a `PlayerView`, with commits masked, and would silently get
the commit phase wrong.

**The WebSocket client is an external store, not React state**, so events are delivered
exactly once and in order. In React state, two messages in one tick are batched and the first
message's events vanish.

**Anything that reads events subscribes above the phase switch** (in `Connected`, in
[Room.tsx](../apps/web/src/screens/Room.tsx)). The message that changes screens carries the
events describing why. A screen that subscribes on mount is always one message late.

**The race screen holds after the race ends** until the board finishes animating, because
the deciding move arrives in the same message that ends the race.

**Board animation resyncs to the true board** whenever its queue drains, so it can never drift
for longer than one turn — some relocations deliberately emit no event.

**Auto-join uses a name saved before arriving**, never the live form field.

---

## 4. Traps

Things that cost time once and will again.

### Engine

- **`DeepMutable` must check primitives first**, or branded ids silently lose their brand.
- **Narrowing of `s.phase` is lost after any `ctx.emit(...)`.** Capture `const phase = s.phase`.
- **The engine declares its own globals** in `globals.d.ts`. The server and web app both
  compile the engine's source against their own runtime types without conflict *only because
  nothing imports `globals.d.ts`*. Keep it that way.

### Server

- **Stopping `wrangler dev` on Windows leaves `workerd.exe` running**, still serving the port
  with every room in memory. Hit this on every single stop, not once. To stop it for real:

  ```powershell
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like '*mythical-runner*' -and
      ($_.Name -eq 'workerd.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*wrangler*')) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```

  Then confirm `http://127.0.0.1:8787/api/health` no longer answers.

- **The Worker serves `apps/web/dist`**, so `npm run dev:server` alone serves whatever was
  last built — stale if the web app has changed since. `npm run start` rebuilds first.

- **Proving persistence**: get a game into race 2, disconnect everyone, kill the process tree
  as above, restart, reconnect with the same credentials. Everything must come back. Local
  room storage is `apps/server/.wrangler/` (gitignored).

- **Drafted hands are public.** A test that greps a player's frame for an opponent's committed
  racer will "find a leak" in `hands`. Check that nothing *outside* `hands` reveals the choice.

### Client

- **Look at the screenshots.** The UI test passing proves the game completes; it does not
  prove anything is readable. Five of the phase 4 fixes were found only by opening the images.
- **Taps race in multiplayer.** Anyone may press "On to race N"; the first tap advances
  everyone and the other players' buttons vanish mid-tap. Tests must tolerate that, and the
  server already treats the resulting stale actions as harmless.
- **Full-page screenshots draw the fixed action bar mid-page.** That is how Chrome renders
  `position: fixed` into a tall capture, not a layout bug.

---

## 5. What is next

### Phase 5 — done

All 36 racers are in [characters/defs/classic.ts](../packages/engine/src/characters/defs/classic.ts),
each with scenario checks in [scenarios.ts](../packages/engine/src/dev/scenarios.ts). Engine
pieces added for wave 2, worth knowing before touching a power:

- **Every hook dispatch goes through `hooksFor`** in
  [characters/powers.ts](../packages/engine/src/characters/powers.ts), never `getHooks`,
  because Copy Cat, Egg and Twin have powers that aren't on their own card.
- **A main move is a `roll` job** between the die and the move: `onMainRoll` (rerolls) then
  `onMainRollFinal` (acting on the number). Hooks after that — `onAnyMainMoveRolled`,
  `modifyMainMove`, `onRacerFinished` — must not `ask`; an invariant enforces it.
- **`h.log` means "my power happened"** and moves Scoocher. Log once per happening.
- **Suckerfish is asked when a move's first step runs, not when it's queued**, so any hook
  may queue a move.
- **"Before my race" is a job** (it can ask), and `phase.nextUp` is a queue shared by
  Skipper and Genius; `phase.turn` counts turns.

- **Rule 8 loops are cut by `firstLap`** in the defs: a power reacting to the same trigger
  with every racer in the same place, twice in one turn, doesn't fire the second time.
  Scoocher and Romantic use it; any new power that reacts to its own consequences should.
- **Timeout defaults decline optional powers**, Alchemist included. Questions with no
  "decline" (Egg, Mastermind, Copy Cat's tie) take the first option.

### Phase 6 — polish

**Done:**

- **Short clock for absent players.** When everyone the game is waiting on is disconnected,
  the deadline is 8 seconds instead of `turnSeconds` — including when a player drops
  mid-turn. "Waiting on" is whoever has a legal action, so there are no per-phase rules.
  Reconnecting restores the full clock. Rooms with the clock off are unaffected.
- **Play again.** `lobby/rematch` takes a finished room back to its lobby: same code, bots
  kept, disconnected players dropped (they can rejoin), fresh seed.
- **Fill bots.** The host adds and removes bots in the lobby (`lobby/addBot`,
  `lobby/removeBot`). `botAction` in the engine picks a random legal move — never
  dismissing the scoreboard — and the room plays it through its alarm, 0.9 s apart, saved
  and broadcast like a human move. Bot ids (`bot-N`) are too short for a browser to connect
  with, so a bot seat can't be hijacked. The host is now the first *human* (`hostOf`).

- **Character sets.** The host toggles sets in the lobby (`lobby/toggleSet`); the draft
  deck and Egg's draw come from `state.racerSets` only. At least one set stays on, and
  Start is withheld until the sets hold `draftSize(players)` racers — Dota alone (16) seats
  at most four. Sets live in [characters/sets.ts](../packages/engine/src/characters/sets.ts);
  each racer names its set in its def.
- **The Dota set** — 16 heroes in
  [characters/defs/dota.ts](../packages/engine/src/characters/defs/dota.ts), designed in
  [new-character-set.md](./new-character-set.md). Engine pieces added for them: every trip
  goes through `tripRacer` (`ignoresTrip`, `onRacerTripped`); `afterMainMove` is a job
  queued behind the main move; `movesByWarp` turns any move into a warp; `modifyAward`
  adjusts cups and star chips; `h.skipMainMove`, `h.silence` and `h.addMainMoveBonus` keep
  their state on the racer under engine-owned memo keys, so it survives a borrowed power
  changing. Copy Cat's machinery is now shared by Morphling (a "mimic" of last place).
  "Once per round" was ruled to mean once per race.

**Still to do:** spectators, a replay viewer, sound, art for the Dota racers.

### Deploying

Not done, and needs you: `wrangler deploy` requires `wrangler login`, an interactive browser
sign-in. Then `npm run build -w @mr/web && npm run deploy -w @mr/server`, from a Cloudflare
account on the **free plan with no payment method** — which is what makes the free-tier
limits hard stops rather than bills. The game is now worth deploying.

---

## 6. Open items

- **Credentials travel in the WebSocket URL's query string**, so they appear in any log that
  records full URLs. Acceptable for a friends' game.
- **Legal:** a commercial, in-print game. Private play is fine; publishing with the real racer
  names and artwork is not. Worth remembering before deploying to a public URL.
