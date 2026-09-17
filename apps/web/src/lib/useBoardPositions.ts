import type { GameEvent, RacerId, StateMessage } from '@mr/engine';
import { useEffect, useRef, useState } from 'react';
import type { RoomClient } from './roomClient';

type Positions = Readonly<Record<string, number>>;

/** Milliseconds per space. Short enough to keep a turn snappy, long enough to follow. */
const HOP_MS = 170;
/** A burst of powers can queue dozens of hops; past this, play faster so turns don't drag. */
const BACKLOG_FAST = 24;
const HOP_FAST_MS = 60;
/** How long the die tumbles, then how long the result sits before the racer moves. */
export const ROLL_TUMBLE_MS = 650;
const ROLL_HOLD_MS = 550;

/** The most recent roll, for the board to show as a die. */
export interface ShownRoll {
  /** Changes with every roll, so the die remounts and tumbles again. */
  readonly key: number;
  readonly racerId: RacerId;
  readonly value: number;
  readonly modifiedBy?: RacerId | undefined;
  /** False while it is part of the turn being played out; true once the next turn begins. */
  readonly stale: boolean;
  /** Shown without the tumble, e.g. under reduced motion. */
  readonly instant: boolean;
}

type Step =
  | { readonly t: 'move'; readonly racer: RacerId; readonly to: number; readonly hop: boolean }
  | { readonly t: 'roll'; readonly racer: RacerId; readonly value: number; readonly modifiedBy?: RacerId | undefined }
  | { readonly t: 'turn' };

function truth(message: StateMessage | null): Positions {
  const out: Record<string, number> = {};
  for (const r of message?.view.board ?? []) out[r.racerId] = r.pos;
  return out;
}

export interface BoardAnimation {
  /** Where to draw each racer right now. */
  readonly positions: Positions;
  /** True while queued moves are still playing out. */
  readonly animating: boolean;
  readonly roll: ShownRoll | null;
}

/**
 * Where to *draw* each racer, which deliberately lags the true state.
 *
 * The server sends the result of a whole turn at once. Drawing that directly would
 * teleport racers, and a Banana trip or a hoofwhack would look like a glitch rather than a
 * consequence. So `racer/moved` events are replayed one space at a time.
 *
 * Owned by the connection, not the race screen, for the same reason as the event log:
 * the final move of a race arrives in the same message that ends it. `animating` lets the
 * room hold the race screen until that move has actually been seen.
 *
 * Two rules keep it honest:
 *
 *  - `racer/warped` snaps rather than hops. The rules say a warp "doesn't count as moving",
 *    and animating it as a walk would misrepresent what happened.
 *  - Once the queue drains, positions reset to the authoritative board. Some relocations
 *    deliberately emit no event — Huge Baby's displacement "doesn't count as a move" — and
 *    a reconnect delivers a snapshot with no events at all. Resyncing means the drawing can
 *    never drift from the truth for longer than one turn.
 *
 * A `dice/rolled` event queues a pause for the die to tumble and land, so everyone sees the
 * number before the racer sets off.
 *
 * Honours `prefers-reduced-motion` by skipping the replay entirely; the die then just shows
 * the latest roll.
 */
export function useBoardPositions(client: RoomClient, message: StateMessage | null): BoardAnimation {
  const [positions, setPositions] = useState<Positions>(() => truth(message));
  const [animating, setAnimating] = useState(false);
  const [roll, setRoll] = useState<ShownRoll | null>(null);
  const rollKey = useRef(0);
  const queue = useRef<Step[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(message);
  latest.current = message;

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    const drain = (): void => {
      timer.current = null;
      const next = queue.current.shift();
      if (!next) {
        setPositions(truth(latest.current));
        setAnimating(false);
        return;
      }
      let delay = 0;
      if (next.t === 'move') {
        setPositions((prev) => ({ ...prev, [next.racer]: next.to }));
        delay = !next.hop ? 0 : queue.current.length > BACKLOG_FAST ? HOP_FAST_MS : HOP_MS;
      } else if (next.t === 'roll') {
        setRoll({
          key: ++rollKey.current,
          racerId: next.racer,
          value: next.value,
          modifiedBy: next.modifiedBy,
          stale: false,
          instant: false,
        });
        // A long backlog means a burst of powers; don't make it longer.
        delay = queue.current.length > BACKLOG_FAST ? HOP_FAST_MS : ROLL_TUMBLE_MS + ROLL_HOLD_MS;
      } else {
        setRoll((prev) => (prev ? { ...prev, stale: true } : prev));
      }
      timer.current = setTimeout(drain, delay);
    };

    const onEvents = (events: readonly GameEvent[]): void => {
      if (reduced.matches || document.hidden) {
        queue.current = [];
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setPositions(truth(latest.current));
        setAnimating(false);
        const last = [...events].reverse().find((e) => e.t === 'dice/rolled');
        if (last?.t === 'dice/rolled') {
          setRoll({
            key: ++rollKey.current,
            racerId: last.racerId,
            value: last.value,
            modifiedBy: last.modifiedBy,
            stale: false,
            instant: true,
          });
        }
        return;
      }

      for (const e of events) {
        if (e.t === 'race/started') {
          // A new race: everyone is back on Start. Drop any stale hops from the last race.
          queue.current = [];
          setRoll(null);
        } else if (e.t === 'dice/rolled') {
          queue.current.push({ t: 'roll', racer: e.racerId, value: e.value, modifiedBy: e.modifiedBy });
        } else if (e.t === 'turn/began') {
          queue.current.push({ t: 'turn' });
        } else if (e.t === 'racer/moved') {
          queue.current.push({ t: 'move', racer: e.racerId, to: e.to, hop: true });
        } else if (e.t === 'racer/warped') {
          queue.current.push({ t: 'move', racer: e.racerId, to: e.to, hop: false });
        }
      }

      if (queue.current.length === 0) {
        if (!timer.current) setPositions(truth(latest.current));
      } else if (!timer.current) {
        setAnimating(true);
        drain();
      }
    };

    const off = client.onEvents(onEvents);
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      queue.current = [];
    };
  }, [client]);

  // Racers joining or leaving the board (a new race, a reconnect snapshot) must show up
  // even when no animation is running.
  const boardKey = (message?.view.board ?? []).map((r) => r.racerId).join('|');
  useEffect(() => {
    if (!timer.current && queue.current.length === 0) setPositions(truth(latest.current));
  }, [boardKey]);

  return { positions, animating, roll };
}
