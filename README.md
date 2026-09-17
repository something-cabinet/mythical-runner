# Mythical Runner

A web implementation of *Magical Athlete* (CMYK 2025 edition): room-based, multiplayer,
turn-based, running at $0/month on Cloudflare's free tier.

## Stack

- **Engine** ([packages/engine](packages/engine)) — the whole game as a pure function, no runtime dependencies
- **Server** ([apps/server](apps/server)) — a Cloudflare Worker + Durable Object per room over WebSockets; also serves the web app's static files
- **Web** ([apps/web](apps/web)) — Vite + React + TypeScript client, mobile-first, light and dark

## Run it

```bash
npm install
npm run start        # builds the web app, then serves app + API at http://127.0.0.1:8787
```

Open that URL in a few browser windows to play.

For frontend work with hot reload, run `npm run dev:server` and `npm run dev:web` together
and open http://localhost:5173.

## Verify it works

```bash
npm run typecheck                    # all workspaces
npm test                             # engine: scenario checks + fuzzed games

# these need `npm run start` running in another terminal
npm run e2e -w @mr/server            # server e2e tests over real WebSockets
npm run test:ui -w @mr/web           # a full game through the UI on phone-sized screens
```
## How to deploy on Cloudflare

Log in to Cloudflare 

```
cd apps/server
npx wrangler login
```

This opens a browser to authorize wrangler against your Cloudflare account.

Build the web client, then deploy the Worker (which serves both the static site and the API/Durable Object):

```
npm run build -w @mr/web
npm run deploy -w @mr/server
```

Verify — hit https://mythical-runner.khoalamvn.workers.dev/api/health and open the site in a couple of browser tabs to play a room end-to-end, same as the local verification in STATUS.md.

## Docs

See [docs/STATUS.md](docs/STATUS.md) for full status, load-bearing decisions, known traps,
and what's next. See [docs/magical-athlete-rules.md](docs/magical-athlete-rules.md) for the
rules authority and [docs/plan-cloudflare.md](docs/plan-cloudflare.md) for the implementation
plan.

## Legal

*Magical Athlete* is a commercial, in-print game. Private play is fine; publishing with the
real racer names and artwork is not.
