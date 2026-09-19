import type { CreateRoomResponse, RoomInfoResponse } from '@mr/engine';

/**
 * HTTP calls are relative: in production the SPA and API share an origin, and in
 * development Vite proxies `/api` to wrangler, so there is no base URL to configure.
 */
const API_BASE = '';

export async function createRoom(turnSeconds: number): Promise<string> {
  const res = await fetch(`${API_BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnSeconds }),
  });
  if (!res.ok) throw new Error(`Could not create a room (${res.status}).`);
  return ((await res.json()) as CreateRoomResponse).code;
}

export async function fetchRoomInfo(code: string): Promise<RoomInfoResponse> {
  const res = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(code)}`);
  if (res.status === 404) {
    return { code, exists: false, phase: null, playerCount: 0, maxPlayers: 6, joinable: false };
  }
  if (!res.ok) throw new Error(`Could not reach the room (${res.status}).`);
  return (await res.json()) as RoomInfoResponse;
}

/** Normalises a typed code; null if it cannot be one. Mirrors the server's alphabet. */
export function normalizeCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-HJ-NP-Z2-9]{4}$/.test(code) ? code : null;
}
