/**
 * Who this browser is, per room.
 *
 * There are no accounts. The first time a browser joins a room it invents a random
 * `playerId` and `secret` and keeps them here; the room remembers a hash of the secret and
 * requires it on every reconnect. Losing these (clearing site data, another device) means
 * the seat cannot be reclaimed — which is fine for a game among friends.
 *
 * localStorage can be unavailable or throw (private windows, blocked storage), so every
 * access is guarded. Without storage the game still works; it just cannot survive a reload.
 */

export interface Credentials {
  readonly playerId: string;
  readonly secret: string;
}

const NAME_KEY = 'mr:name';
const credKey = (code: string): string => `mr:cred:${code}`;

// 64 symbols, so masking a random byte with 63 is unbiased.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join('');
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the session still works, it just won't survive a reload.
  }
}

export function loadName(): string {
  return read(NAME_KEY) ?? '';
}

export function saveName(name: string): void {
  write(NAME_KEY, name.trim().slice(0, 24));
}

export function loadCredentials(code: string): Credentials | null {
  const raw = read(credKey(code));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (typeof parsed.playerId === 'string' && typeof parsed.secret === 'string') {
      return { playerId: parsed.playerId, secret: parsed.secret };
    }
  } catch {
    // fall through to treat as absent
  }
  return null;
}

export function getOrCreateCredentials(code: string): Credentials {
  const existing = loadCredentials(code);
  if (existing) return existing;
  const created: Credentials = { playerId: `p_${randomToken(16)}`, secret: randomToken(32) };
  write(credKey(code), JSON.stringify(created));
  return created;
}

/** Drops a seat, so the next join takes a fresh one. */
export function forgetCredentials(code: string): void {
  write(credKey(code), null);
}
