import { DurableObject } from 'cloudflare:workers';
import {
  applyAction,
  botAction,
  CLIENT_ACTION_TYPES,
  CLOSE_CODES,
  IllegalActionError,
  initGame,
  legalActions,
  MAX_PLAYERS,
  playerId as toPlayerId,
  redact,
  type Action,
  type ClientAction,
  type ErrorCode,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RoomInfoResponse,
  type ServerMessage,
  type StateMessage,
} from '@mr/engine';
import { cleanName, digestsEqual, hashSecret, isValidPlayerId, isValidSecret } from './auth.js';
import type { Env } from './env.js';

/**
 * One room, one Durable Object.
 *
 * The object is the single authority for a game. Every action from every player funnels
 * through it one at a time — Durable Objects are single-threaded — so there is no
 * concurrency control to write: two players acting at once simply queue.
 *
 * ## Hibernation
 *
 * Sockets are accepted with the Hibernation API, so an idle room costs nothing between
 * moves. The consequence shapes this whole class: **instance fields do not survive
 * hibernation.** The constructor runs again on wake and reloads from storage, and per-socket
 * identity lives in the socket's serialized attachment rather than in a Map.
 *
 * ## Persistence: per action, not debounced
 *
 * The plan called for a debounced snapshot to save row writes. That turned out to be
 * wrong for two reasons. A pending `setTimeout` *prevents* hibernation, so a debounce timer
 * keeps the object awake after every move; and an eviction during the debounce window
 * silently loses moves that clients have already seen. Writing once per action is correct
 * under both, and at ~210 actions a game the 100k/day free row-write budget still covers
 * hundreds of games a day.
 *
 * ## Bots
 *
 * Bot seats are played by the room itself: whenever a bot has a move, the alarm is set a
 * moment ahead and `alarm()` makes it, persisted and broadcast exactly like a human move.
 * Nothing about a bot lives outside `GameState`, so hibernation is a non-event for them.
 *
 * ## Storage keys
 *
 *   meta       { code, createdAt, turnSeconds }   written once
 *   state      GameState                           written per action
 *   secrets    Record<PlayerId, sha256 hex>        written when a new player registers
 *   expiresAt  number                              written when the room empties
 */

interface Meta {
  readonly code: string;
  readonly createdAt: number;
  readonly turnSeconds: number;
}

/** Per-socket identity, stored on the socket so it survives hibernation. */
interface Attachment {
  readonly playerId: PlayerId;
}

/**
 * The turn clock when everyone the game is waiting on is disconnected.
 *
 * An absent player would otherwise cost the table a full `turnSeconds` on every one of
 * their turns. Short, but not zero: long enough to ride out a phone briefly locking, and a
 * player who reconnects gets the full clock back.
 */
const OFFLINE_TURN_SECONDS = 8;

/**
 * How long a bot "thinks" before each move. Bots move through the alarm rather than
 * instantly, so each bot move is its own broadcast the table can watch, and a string of
 * bot turns can't monopolise the object.
 */
const BOT_MOVE_DELAY_MS = 900;

/**
 * How long a player gets to pick which racer goes next when they have multiple
 * racers to move (two-player variant). Shorter than the full turn timer because
 * there's no die roll or power interaction involved — just a selection.
 */
const RACER_SELECTION_SECONDS = 15;

/** How long an empty room lingers before deleting itself. */
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000;

/** Largest inbound message accepted. Real messages are well under 1 KB. */
const MAX_MESSAGE_BYTES = 8192;

const CLIENT_TYPES: ReadonlySet<string> = new Set(CLIENT_ACTION_TYPES);

export class RoomDO extends DurableObject<Env> {
  private meta: Meta | null = null;
  private state: GameState | null = null;
  private secrets: Record<string, string> = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on first creation AND on every wake from hibernation. Nothing may be handled
    // until state is back in memory, which is exactly what blockConcurrencyWhile ensures.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<unknown>(['meta', 'state', 'secrets']);
      this.meta = (stored.get('meta') as Meta | undefined) ?? null;
      this.state = (stored.get('state') as GameState | undefined) ?? null;
      this.secrets = (stored.get('secrets') as Record<string, string> | undefined) ?? {};
    });
  }

  // ---------------------------------------------------------------------------
  // RPC — called by the Worker
  // ---------------------------------------------------------------------------

  /**
   * Initialises a brand-new room.
   *
   * @returns false if this object already holds a room, meaning the generated code
   *          collided and the Worker should try another.
   */
  async init(code: string, turnSeconds: number): Promise<boolean> {
    if (this.meta) return false;

    const meta: Meta = { code, createdAt: Date.now(), turnSeconds };
    const state = initGame(secureSeed());

    await this.ctx.storage.put({ meta, state, secrets: {}, expiresAt: Date.now() + EMPTY_ROOM_TTL_MS });
    this.meta = meta;
    this.state = state;
    this.secrets = {};

    // A room created and never joined must still clean itself up.
    await this.scheduleAlarm();
    return true;
  }

  async info(): Promise<RoomInfoResponse> {
    const { meta, state } = this;
    if (!meta || !state) {
      return { code: '', exists: false, phase: null, playerCount: 0, maxPlayers: MAX_PLAYERS, joinable: false };
    }
    return {
      code: meta.code,
      exists: true,
      phase: state.phase.t,
      playerCount: state.players.length,
      maxPlayers: MAX_PLAYERS,
      joinable: state.phase.t === 'lobby' && state.players.length < MAX_PLAYERS,
    };
  }

  // ---------------------------------------------------------------------------
  // WebSocket upgrade
  // ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (!this.meta || !this.state) return reject(client, server, 'room_not_found', 'No such room.');

    const rawId = url.searchParams.get('playerId');
    const secret = url.searchParams.get('secret');
    if (!isValidPlayerId(rawId) || !isValidSecret(secret)) {
      return reject(client, server, 'bad_request', 'Missing or malformed credentials.');
    }
    const pid = toPlayerId(rawId);
    const name = cleanName(url.searchParams.get('name'));
    const digest = await hashSecret(secret);

    const knownDigest = this.secrets[pid];
    if (knownDigest !== undefined && !digestsEqual(knownDigest, digest)) {
      return reject(client, server, 'bad_credentials', 'That seat belongs to someone else.');
    }

    const seated = this.state.players.some((p) => p.id === pid);
    const inLobby = this.state.phase.t === 'lobby';

    // Decide what joining means for this socket before touching any state, so a rejected
    // join never registers a secret.
    let action: Action;
    if (seated) {
      action = inLobby
        ? { t: 'lobby/join', by: pid, name } // the engine treats a re-join as a reconnect
        : { t: 'lobby/setConnected', by: pid, connected: true };
    } else if (!inLobby) {
      return reject(client, server, 'game_in_progress', 'That game has already started.');
    } else if (this.state.players.length >= MAX_PLAYERS) {
      return reject(client, server, 'room_full', 'That room is full.');
    } else {
      action = { t: 'lobby/join', by: pid, name };
    }

    let events: readonly GameEvent[];
    try {
      // A reconnect mid-game restarts the clock, so a player returning to a turn that
      // nearly expired while they were away gets a fair chance to take it.
      events = this.apply(action, { resetClock: !inLobby });
    } catch (err) {
      if (err instanceof IllegalActionError) return reject(client, server, 'room_full', err.message);
      console.error('join failed', err);
      return reject(client, server, 'bad_request', 'Could not join.');
    }

    // Tagged by player id so a player's sockets — one per open tab — can be found again.
    this.ctx.acceptWebSocket(server, [pid]);
    server.serializeAttachment({ playerId: pid } satisfies Attachment);

    if (knownDigest === undefined) this.secrets[pid] = digest;

    await this.ctx.storage.put({ state: this.state, secrets: this.secrets });
    // Someone is here again; the room is no longer at risk of expiring.
    await this.ctx.storage.delete('expiresAt');
    await this.scheduleAlarm();

    this.broadcast(events);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------------------
  // Hibernation handlers
  // ---------------------------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const who = attachmentOf(ws);
    if (!who || !this.state) return;

    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      this.sendError(ws, 'bad_request', parsed.error);
      return;
    }

    // Stamp the acting player from the authenticated socket. Never from the message.
    const action = { ...parsed.action, by: who.playerId } as Action;

    let events: readonly GameEvent[];
    try {
      events = this.apply(action, { resetClock: true });
    } catch (err) {
      if (err instanceof IllegalActionError) {
        // Usually just a stale click — the player acted on a state that has since moved
        // on. Resend the current state so their client re-renders from the truth.
        this.sendError(ws, 'illegal_action', err.message);
        this.sendState(ws, who.playerId, []);
        return;
      }
      console.error('action failed', action, err);
      this.sendError(ws, 'internal', 'Something went wrong applying that action.');
      this.sendState(ws, who.playerId, []);
      return;
    }

    await this.ctx.storage.put('state', this.state);
    await this.scheduleAlarm();
    this.broadcast(events);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // With compatibility_date >= 2026-04-07 the runtime completes the close handshake
    // itself, so there is no ws.close() here.
    await this.handleDeparture(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDeparture(ws);
  }

  // ---------------------------------------------------------------------------
  // Alarm — turn clock and room expiry share the one alarm a Durable Object gets
  // ---------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    if (!this.state) {
      await this.ctx.storage.deleteAll();
      return;
    }

    const now = Date.now();

    if (this.openSockets().length === 0) {
      const expiresAt = await this.ctx.storage.get<number>('expiresAt');
      if (expiresAt !== undefined && now >= expiresAt) {
        await this.destroy();
        return;
      }
      // Nobody is watching, so the clock does not auto-play the game to its end. It
      // waits; the room either gets rejoined or expires.
      await this.ctx.storage.setAlarm(expiresAt ?? now + EMPTY_ROOM_TTL_MS);
      return;
    }

    const bot = botAction(this.state);
    if (bot) {
      try {
        const events = this.apply(bot, { resetClock: true });
        await this.ctx.storage.put('state', this.state);
        this.broadcast(events);
      } catch (err) {
        // botAction only offers legal moves, so this is an engine bug. The turn clock is
        // still running and will move the game on.
        console.error('bot move failed', bot, err);
      }
      await this.scheduleAlarm();
      return;
    }

    const { deadline } = this.state;
    if (deadline !== null && now >= deadline) {
      try {
        const events = this.apply({ t: 'system/timeout', at: Math.max(now, deadline) }, { resetClock: true });
        await this.ctx.storage.put('state', this.state);
        this.broadcast(events);
      } catch (err) {
        // A timeout that throws is an engine bug. Clearing the deadline stalls this one
        // game, which is far better than an alarm that retries into the same exception
        // forever.
        console.error('timeout failed', err);
        this.state = { ...this.state, deadline: null };
        await this.ctx.storage.put('state', this.state);
      }
    }

    await this.scheduleAlarm();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Applies an action to the authoritative state.
   *
   * All-or-nothing: `applyAction` either returns a new state or throws having changed
   * nothing, and `this.state` is only replaced on success.
   *
   * @param resetClock restart the turn clock. False for connection bookkeeping, so a
   *        flapping connection cannot buy a player extra time.
   */
  private apply(action: Action, opts: { resetClock: boolean }): readonly GameEvent[] {
    if (!this.state || !this.meta) throw new Error('room not initialised');

    const result = applyAction(this.state, action);
    let next = result.state;

    if (opts.resetClock) {
      // `deadline` is server-owned: the engine only reads it to validate a timeout.
      next = { ...next, deadline: this.deadlineFor(next) };
    }

    this.state = next;
    return result.events;
  }

  private deadlineFor(state: GameState): number | null {
    if (!this.meta || this.meta.turnSeconds <= 0) return null;
    if (state.phase.t === 'lobby' || state.phase.t === 'gameOver') return null;

    // Racer selection: the active player needs to pick which racer goes next.
    // No dice roll or power is pending yet — just a choice, so a shorter timer is fine.
    const ph = state.phase;
    if (ph.t === 'racing' && ph.toMove.length > 1 && ph.moving === null) {
      const player = state.players.find((p) => p.id === ph.active);
      if (player?.bot) {
        // Bot: almost immediate; botAction picks one via the alarm anyway.
        return Date.now() + 100;
      }
      return Date.now() + Math.min(RACER_SELECTION_SECONDS, this.meta.turnSeconds) * 1000;
    }

    const seconds = waitingOnlyOnAbsent(state)
      ? Math.min(OFFLINE_TURN_SECONDS, this.meta.turnSeconds)
      : this.meta.turnSeconds;
    return Date.now() + seconds * 1000;
  }

  /** Points the single alarm at whichever comes first: a bot's move, the turn deadline, or expiry. */
  private async scheduleAlarm(): Promise<void> {
    const candidates: number[] = [];
    if (this.state && botAction(this.state)) candidates.push(Date.now() + BOT_MOVE_DELAY_MS);
    if (this.state?.deadline != null) candidates.push(this.state.deadline);
    const expiresAt = await this.ctx.storage.get<number>('expiresAt');
    if (expiresAt !== undefined) candidates.push(expiresAt);

    if (candidates.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private async handleDeparture(ws: WebSocket): Promise<void> {
    const who = attachmentOf(ws);
    if (!who || !this.state) return;

    // A player with another tab still open has not left.
    const stillHere = this.ctx
      .getWebSockets(who.playerId)
      .some((other) => other !== ws && other.readyState === WebSocket.READY_STATE_OPEN);

    if (!stillHere && this.state.players.some((p) => p.id === who.playerId)) {
      try {
        const events = this.apply(
          { t: 'lobby/setConnected', by: who.playerId, connected: false },
          { resetClock: false },
        );
        // Leaving mid-turn: if the game is now waiting only on absent players, stop
        // waiting a full turn for them. Only ever shortens — not a way to reset the clock.
        const { deadline } = this.state;
        if (deadline !== null && waitingOnlyOnAbsent(this.state)) {
          const offline = this.deadlineFor(this.state);
          if (offline !== null && offline < deadline) this.state = { ...this.state, deadline: offline };
        }
        await this.ctx.storage.put('state', this.state);
        this.broadcast(events);
      } catch (err) {
        console.error('disconnect bookkeeping failed', err);
      }
    }

    if (this.openSockets().filter((s) => s !== ws).length === 0) {
      await this.ctx.storage.put('expiresAt', Date.now() + EMPTY_ROOM_TTL_MS);
    }
    await this.scheduleAlarm();
  }

  private async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CLOSE_CODES.room_not_found, 'Room expired.');
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAll();
    this.meta = null;
    this.state = null;
    this.secrets = {};
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
  }

  /** Sends every connected socket its own redacted view. */
  private broadcast(events: readonly GameEvent[]): void {
    for (const ws of this.ctx.getWebSockets()) {
      const who = attachmentOf(ws);
      if (who) this.sendState(ws, who.playerId, events);
    }
  }

  private sendState(ws: WebSocket, pid: PlayerId, events: readonly GameEvent[]): void {
    if (!this.state || !this.meta) return;
    const message: StateMessage = {
      t: 'state',
      // redact() is the only path from authoritative state to the wire. It strips the
      // seed, masks other players' commits, and drops engine internals.
      view: redact(this.state, pid),
      events,
      legal: legalFor(this.state, pid),
      turnSeconds: this.meta.turnSeconds,
    };
    send(ws, message);
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    send(ws, { t: 'error', code, message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A 32-bit seed from the platform CSPRNG.
 *
 * Not `Math.random`: the seed determines every roll in the game, so a predictable seed is
 * a predictable game.
 */
function secureSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] ?? 0;
}

function attachmentOf(ws: WebSocket): Attachment | null {
  const value = ws.deserializeAttachment() as Attachment | null;
  return value && typeof value.playerId === 'string' ? value : null;
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket closed between being listed and being written to; webSocketClose will
    // handle the departure.
  }
}

/**
 * Rejects an upgrade in a way a browser can actually observe.
 *
 * A browser's WebSocket API does not expose the HTTP status of a failed upgrade — it just
 * fires a generic error. So the socket is accepted, told why in an `error` message, and
 * closed with an application close code, both of which the client can read.
 *
 * Uses a plain `accept()` rather than `acceptWebSocket()`: these sockets live for one
 * message and must not join the hibernation set or appear in `getWebSockets()`.
 */
function reject(
  client: WebSocket,
  server: WebSocket,
  code: keyof typeof CLOSE_CODES,
  message: string,
): Response {
  server.accept();
  send(server, { t: 'error', code, message });
  server.close(CLOSE_CODES[code], message);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * True when the game is blocked only on players who aren't connected.
 *
 * "Blocked on" is whoever has a legal move right now — the active racer, whoever owes a
 * decision, drafters and committers still to go — so this needs no per-phase rules of its
 * own. After a race everyone may press continue, so one player present is enough to keep
 * the full clock.
 */
function waitingOnlyOnAbsent(state: GameState): boolean {
  const waitingOn = state.players.filter((p) => legalActions(state, p.id).length > 0);
  return waitingOn.length > 0 && waitingOn.every((p) => !p.connected);
}

/** Legal actions for one player, with `by` stripped, restricted to what a client may send. */
function legalFor(state: GameState, pid: PlayerId): ClientAction[] {
  return legalActions(state, pid)
    .filter((a) => CLIENT_TYPES.has(a.t))
    .map((a) => {
      const { by: _by, ...rest } = a as Action & { by: PlayerId };
      void _by;
      return rest as ClientAction;
    });
}

type Parsed = { ok: true; action: ClientAction } | { ok: false; error: string };

/** Validates an inbound message's shape. The engine validates its legality afterwards. */
function parseClientMessage(message: string | ArrayBuffer): Parsed {
  if (typeof message !== 'string') return { ok: false, error: 'Binary messages are not supported.' };
  if (message.length > MAX_MESSAGE_BYTES) return { ok: false, error: 'Message too large.' };

  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch {
    return { ok: false, error: 'Malformed JSON.' };
  }

  if (typeof data !== 'object' || data === null) return { ok: false, error: 'Expected an object.' };
  const msg = data as { t?: unknown; action?: unknown };
  if (msg.t !== 'action') return { ok: false, error: `Unknown message type.` };

  const action = msg.action as { t?: unknown } | null;
  if (typeof action !== 'object' || action === null || typeof action.t !== 'string') {
    return { ok: false, error: 'Missing action.' };
  }
  if (!CLIENT_TYPES.has(action.t)) {
    return { ok: false, error: `Clients may not send '${action.t}'.` };
  }
  return { ok: true, action: action as ClientAction };
}
