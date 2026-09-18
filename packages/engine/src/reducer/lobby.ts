import type {
  LobbyAddBot,
  LobbyJoin,
  LobbyLeave,
  LobbyRematch,
  LobbyRemoveBot,
  LobbySetConnected,
  LobbyStart,
  LobbyToggleSet,
} from '../actions.js';
import { racersInSets } from '../characters/registry.js';
import { CHARACTER_SETS, isCharacterSetId, type CharacterSetId } from '../characters/sets.js';
import { IllegalActionError } from '../errors.js';
import { playerId, type PlayerId } from '../ids.js';
import type { Rng } from '../rng.js';
import { draftSize, MAX_PLAYERS, MIN_PLAYERS, type Player } from '../state.js';
import type { Ctx } from './working.js';

/**
 * The host: the longest-seated human. Bots never host — a room whose human host left
 * would otherwise be stuck with a host that can't press Start.
 */
export function hostOf(players: readonly Player[]): Player | undefined {
  return players.find((p) => !p.bot);
}

export function join(ctx: Ctx, a: LobbyJoin): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') throw new IllegalActionError(a, 'game already started');
  if (s.players.some((p) => p.id === a.by)) {
    // Re-joining is a reconnect, not an error. Flip the flag and move on.
    setConnected(ctx, { t: 'lobby/setConnected', by: a.by, connected: true });
    return;
  }
  if (s.players.length >= MAX_PLAYERS) throw new IllegalActionError(a, 'room is full');

  const name = a.name.trim().slice(0, 24) || `Player ${s.players.length + 1}`;
  seat(ctx, { id: a.by, name, connected: true });
}

export function leave(ctx: Ctx, a: LobbyLeave): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') {
    // Mid-game departures do not free the seat — the turn timer covers absent players,
    // and removing them would invalidate seat order and everyone's scores.
    setConnected(ctx, { t: 'lobby/setConnected', by: a.by, connected: false });
    return;
  }
  if (!s.players.some((p) => p.id === a.by)) throw new IllegalActionError(a, 'not in this room');
  unseat(ctx, a.by);
}

export function setConnected(ctx: Ctx, a: LobbySetConnected): void {
  const player = ctx.s.players.find((p) => p.id === a.by);
  if (!player) throw new IllegalActionError(a, 'not in this room');
  if (player.bot) throw new IllegalActionError(a, 'bots do not connect');
  player.connected = a.connected;
}

export function start(ctx: Ctx, a: LobbyStart): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') throw new IllegalActionError(a, 'game already started');
  if (s.players.length < MIN_PLAYERS) {
    throw new IllegalActionError(a, `need at least ${MIN_PLAYERS} players`);
  }
  if (hostOf(s.players)?.id !== a.by) throw new IllegalActionError(a, 'only the host may start');
  if (!enoughRacers(s.racerSets, s.players.length)) {
    throw new IllegalActionError(a, 'the chosen sets have too few racers for this many players');
  }

  s.seatOrder = s.players.map((p) => p.id) as PlayerId[];
  ctx.emit({ t: 'game/started', seatOrder: [...s.seatOrder] });

  // Everyone rolls off for draft order before anything else happens.
  s.phase = {
    t: 'draftRoll',
    rolls: Object.fromEntries(s.seatOrder.map((p) => [p, null])),
  };
}

/** Whether the chosen sets hold enough racers for everyone to draft a full team. */
export function enoughRacers(sets: readonly CharacterSetId[], playerCount: number): boolean {
  return racersInSets(sets).length >= draftSize(playerCount);
}

/**
 * Adds a character set to the draft deck, or takes it out.
 *
 * A set that is too small for the table can still be chosen — the host may be waiting on
 * a friend to leave, or about to add another set — and Start simply stays unavailable
 * until the deck is big enough.
 */
export function toggleSet(ctx: Ctx, a: LobbyToggleSet): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') throw new IllegalActionError(a, 'game already started');
  if (hostOf(s.players)?.id !== a.by) throw new IllegalActionError(a, 'only the host may pick sets');
  if (!isCharacterSetId(a.set)) throw new IllegalActionError(a, 'no such set');

  const on = !s.racerSets.includes(a.set);
  if (!on && s.racerSets.length === 1) throw new IllegalActionError(a, 'at least one set must stay in');
  const chosen = new Set(on ? [...s.racerSets, a.set] : s.racerSets.filter((x) => x !== a.set));
  // Kept in the canonical order, so the same choice always looks the same.
  s.racerSets = CHARACTER_SETS.map((x) => x.id).filter((id) => chosen.has(id));
  ctx.emit({ t: 'lobby/setsChanged', sets: [...s.racerSets] });
}

/**
 * Seats a computer player.
 *
 * Bot ids are `bot-N`, deliberately shorter than any id a browser may connect with, so no
 * one can take over a bot's seat by connecting under its id.
 */
export function addBot(ctx: Ctx, a: LobbyAddBot): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') throw new IllegalActionError(a, 'game already started');
  if (hostOf(s.players)?.id !== a.by) throw new IllegalActionError(a, 'only the host may add bots');
  if (s.players.length >= MAX_PLAYERS) throw new IllegalActionError(a, 'room is full');

  let n = 1;
  while (s.players.some((p) => p.id === playerId(`bot-${n}`))) n++;
  seat(ctx, { id: playerId(`bot-${n}`), name: `Bot ${n}`, connected: true, bot: true });
}

export function removeBot(ctx: Ctx, a: LobbyRemoveBot): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') throw new IllegalActionError(a, 'game already started');
  if (hostOf(s.players)?.id !== a.by) throw new IllegalActionError(a, 'only the host may remove bots');
  if (!s.players.some((p) => p.id === a.player && p.bot)) {
    throw new IllegalActionError(a, 'no such bot');
  }
  unseat(ctx, a.player);
}

/**
 * Clears a finished game and reopens the lobby, keeping the room and the people in it.
 *
 * Players who are not connected are dropped rather than carried into a game they are not
 * here for; they can simply rejoin with the same link. Bots stay. The seed is replaced —
 * drawn from the old stream, so it stays as secret as the old seed was.
 */
export function rematch(ctx: Ctx, a: LobbyRematch, rng: Rng): void {
  const { s } = ctx;
  if (s.phase.t !== 'gameOver') throw new IllegalActionError(a, 'the game is not over');
  if (!s.players.some((p) => p.id === a.by && !p.bot)) {
    throw new IllegalActionError(a, 'not in this room');
  }

  const staying = s.players.filter((p) => p.bot || p.connected || p.id === a.by);
  s.seed = rng.nextInt(0x100000000);
  s.players = [];
  s.seatOrder = [];
  s.hands = {};
  s.used = {};
  s.scores = {};
  s.trailingPlayer = null;
  s.phase = { t: 'lobby' };
  s.board = [];
  s.pending = null;
  s.queue = [];
  s.turnStartPos = -1;
  s.deadline = null;

  ctx.emit({ t: 'game/rematch', by: a.by });
  for (const p of staying) seat(ctx, { ...p, connected: true });
}

function seat(ctx: Ctx, player: Player): void {
  const { s } = ctx;
  s.players.push({ ...player });
  s.hands[player.id] = [];
  s.used[player.id] = [];
  s.scores[player.id] = [];
  ctx.emit({ t: 'player/joined', player: player.id, name: player.name });
}

function unseat(ctx: Ctx, pid: PlayerId): void {
  const { s } = ctx;
  s.players = s.players.filter((p) => p.id !== pid);
  delete s.hands[pid];
  delete s.used[pid];
  delete s.scores[pid];
  ctx.emit({ t: 'player/left', player: pid });
}
