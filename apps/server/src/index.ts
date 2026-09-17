import type { CreateRoomRequest, CreateRoomResponse } from '@mr/engine';
import { generateCode, normalizeCode } from './codes.js';
import type { Env } from './env.js';

export { RoomDO } from './room.js';

/**
 * The Worker: a thin router in front of one Durable Object per room.
 *
 *   POST /api/rooms              create a room, returns { code }
 *   GET  /api/rooms/:code        room info, for the join screen
 *   GET  /api/rooms/:code/ws     WebSocket upgrade, forwarded to the room
 *   GET  /api/health
 *
 * The room code is the Durable Object's name, so any Worker instance anywhere routes a
 * given code to the same object without a lookup table.
 */

const DEFAULT_TURN_SECONDS = 60;
const MIN_TURN_SECONDS = 15;
const MAX_TURN_SECONDS = 600;

/** Attempts at finding an unused code before giving up. Collisions are rare. */
const CODE_ATTEMPTS = 8;

const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9]+)(\/ws)?\/?$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') return json({ ok: true });

    if (url.pathname === '/api/rooms' || url.pathname === '/api/rooms/') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return createRoom(request, env);
    }

    const match = ROOM_PATH.exec(url.pathname);
    if (match) {
      const code = normalizeCode(match[1] ?? '');
      if (!code) return json({ error: 'Not a valid room code' }, 404);

      const room = env.ROOMS.get(env.ROOMS.idFromName(code));

      if (match[2]) return room.fetch(request);
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return json(await room.info());
    }

    // Phase 4 serves the SPA from static assets for everything outside /api.
    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  let body: CreateRoomRequest = {};
  if (request.headers.get('content-length') !== '0' && request.body) {
    try {
      body = (await request.json()) as CreateRoomRequest;
    } catch {
      return json({ error: 'Malformed JSON body' }, 400);
    }
  }

  const turnSeconds = clampTurnSeconds(body.turnSeconds);

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = generateCode();
    const room = env.ROOMS.get(env.ROOMS.idFromName(code));
    // init() refuses if the object already holds a room, which is how a collision surfaces.
    if (await room.init(code, turnSeconds)) {
      return json({ code } satisfies CreateRoomResponse, 201);
    }
  }
  return json({ error: 'Could not allocate a room code; try again' }, 503);
}

/** 0 disables the clock. Anything else is clamped to a sane range. */
function clampTurnSeconds(value: unknown): number {
  if (value === 0) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TURN_SECONDS;
  return Math.min(MAX_TURN_SECONDS, Math.max(MIN_TURN_SECONDS, Math.round(value)));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
