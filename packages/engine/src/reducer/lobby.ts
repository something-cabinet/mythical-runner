import type { LobbyJoin, LobbyLeave, LobbySetConnected, LobbyStart } from '../actions.js';
import { IllegalActionError } from '../errors.js';
import type { PlayerId } from '../ids.js';
import { MAX_PLAYERS, MIN_PLAYERS } from '../state.js';
import type { Ctx } from './working.js';

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
  s.players.push({ id: a.by, name, connected: true });
  s.hands[a.by] = [];
  s.used[a.by] = [];
  s.scores[a.by] = [];
  ctx.emit({ t: 'player/joined', player: a.by, name });
}

export function leave(ctx: Ctx, a: LobbyLeave): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') {
    // Mid-game departures do not free the seat — the turn timer covers absent players,
    // and removing them would invalidate seat order and everyone's scores.
    setConnected(ctx, { t: 'lobby/setConnected', by: a.by, connected: false });
    return;
  }
  const i = s.players.findIndex((p) => p.id === a.by);
  if (i < 0) throw new IllegalActionError(a, 'not in this room');

  s.players.splice(i, 1);
  delete s.hands[a.by];
  delete s.used[a.by];
  delete s.scores[a.by];
  ctx.emit({ t: 'player/left', player: a.by });
}

export function setConnected(ctx: Ctx, a: LobbySetConnected): void {
  const player = ctx.s.players.find((p) => p.id === a.by);
  if (!player) throw new IllegalActionError(a, 'not in this room');
  player.connected = a.connected;
}

export function start(ctx: Ctx, a: LobbyStart): void {
  const { s } = ctx;
  if (s.phase.t !== 'lobby') throw new IllegalActionError(a, 'game already started');
  if (s.players.length < MIN_PLAYERS) {
    throw new IllegalActionError(a, `need at least ${MIN_PLAYERS} players`);
  }
  if (s.players[0]?.id !== a.by) throw new IllegalActionError(a, 'only the host may start');

  s.seatOrder = s.players.map((p) => p.id) as PlayerId[];
  ctx.emit({ t: 'game/started', seatOrder: [...s.seatOrder] });

  // Everyone rolls off for draft order before anything else happens.
  s.phase = {
    t: 'draftRoll',
    rolls: Object.fromEntries(s.seatOrder.map((p) => [p, null])),
  };
}
