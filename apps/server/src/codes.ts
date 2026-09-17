/**
 * Room join codes.
 *
 * Four characters from an alphabet with the visually ambiguous ones removed — no 0/O,
 * no 1/I — because codes get read aloud and typed on phones. 32^4 is about a million
 * codes, which is ample given rooms delete themselves once abandoned.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

const VALID = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  // 256 is an exact multiple of 32, so the modulo introduces no bias.
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Upper-cases and validates a user-typed code. Returns null if it cannot be a room. */
export function normalizeCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return VALID.test(code) ? code : null;
}
