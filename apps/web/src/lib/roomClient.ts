import {
  CLOSE_CODES,
  type ClientAction,
  type ErrorCode,
  type GameEvent,
  type ServerMessage,
  type StateMessage,
} from '@mr/engine';
import type { Credentials } from './identity';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

export interface RoomSnapshot {
  readonly status: ConnectionStatus;
  /** The latest full state from the server, or null before the first one arrives. */
  readonly message: StateMessage | null;
  /**
   * Set when the server refused us for a reason retrying will not fix: bad credentials,
   * no such room, room full, game already in progress. The client stops reconnecting.
   */
  readonly fatal: { readonly code: ErrorCode; readonly message: string } | null;
  /** The last error worth showing. Stale-click rejections are deliberately not surfaced. */
  readonly notice: string | null;
  /**
   * True between sending an action and hearing back. The UI disables its controls so a
   * double-tap cannot send the same move twice.
   */
  readonly awaiting: boolean;
}

type Listener = () => void;
type EventListener = (events: readonly GameEvent[], message: StateMessage) => void;

const FATAL_CLOSE_CODES: ReadonlyMap<number, ErrorCode> = new Map([
  [CLOSE_CODES.bad_request, 'bad_request'],
  [CLOSE_CODES.bad_credentials, 'bad_credentials'],
  [CLOSE_CODES.room_full, 'room_full'],
  [CLOSE_CODES.room_not_found, 'room_not_found'],
]);

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

/** If the server never answers an action, stop blocking the UI after this long. */
const AWAIT_TIMEOUT_MS = 6000;

/**
 * One connection to one room.
 *
 * A plain external store rather than React state, for two reasons. The socket's lifetime
 * should not be tied to render cycles. And events must be delivered exactly once, in
 * order — if they lived in React state, two messages arriving in the same tick would be
 * batched and the first message's events silently dropped, losing animations.
 */
export class RoomClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastError: { code: ErrorCode; message: string } | null = null;

  private snapshot: RoomSnapshot = {
    status: 'connecting',
    message: null,
    fatal: null,
    notice: null,
    awaiting: false,
  };

  private readonly listeners = new Set<Listener>();
  private readonly eventListeners = new Set<EventListener>();

  constructor(
    private readonly code: string,
    private readonly credentials: Credentials,
    private readonly name: string,
  ) {}

  // --- useSyncExternalStore contract ------------------------------------------

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RoomSnapshot => this.snapshot;

  /** Receives every batch of events, in order, exactly once. */
  onEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** Safe to call repeatedly; React StrictMode starts, stops and restarts effects. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, 'leaving');
  }

  send(action: ClientAction): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.snapshot.awaiting) return;
    socket.send(JSON.stringify({ t: 'action', action }));
    this.update({ awaiting: true, notice: null });
    this.awaitTimer = setTimeout(() => this.update({ awaiting: false }), AWAIT_TIMEOUT_MS);
  }

  // --- Internals ---------------------------------------------------------------

  private open(): void {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({
      playerId: this.credentials.playerId,
      secret: this.credentials.secret,
      name: this.name,
    });
    const socket = new WebSocket(`${scheme}//${location.host}/api/rooms/${this.code}/ws?${query}`);
    this.socket = socket;
    this.lastError = null;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.update({ status: 'open' });
    });

    socket.addEventListener('message', (e) => {
      if (this.socket !== socket || typeof e.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    });

    socket.addEventListener('close', (e) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearAwait();

      const fatal = FATAL_CLOSE_CODES.get(e.code);
      if (fatal) {
        this.running = false;
        this.update({
          awaiting: false,
          fatal: { code: this.lastError?.code ?? fatal, message: this.lastError?.message ?? e.reason },
        });
        return;
      }
      if (!this.running) return;

      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 8000;
      this.attempt++;
      this.update({ status: 'reconnecting', awaiting: false });
      this.reconnectTimer = setTimeout(() => {
        if (this.running) this.open();
      }, delay);
    });
  }

  private handle(msg: ServerMessage): void {
    if (msg.t === 'error') {
      this.lastError = { code: msg.code, message: msg.message };
      // A stale click — acting on a state that had already moved on — is normal in a
      // live multiplayer game. The server follows it with fresh state; nothing to show.
      const notice = msg.code === 'illegal_action' ? null : msg.message;
      this.clearAwait();
      this.update({ awaiting: false, notice });
      return;
    }

    this.clearAwait();
    this.update({ message: msg, awaiting: false });
    for (const listener of [...this.eventListeners]) listener(msg.events, msg);
  }

  private update(patch: Partial<RoomSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private clearAwait(): void {
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    this.awaitTimer = null;
  }

  private clearTimers(): void {
    this.clearAwait();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
