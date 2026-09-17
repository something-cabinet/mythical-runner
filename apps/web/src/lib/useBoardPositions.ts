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
  /** Changes with every throw, so the die remounts and tumbles again. */
  readonly key: number;
  readonly racerId: RacerId;
  /** The face on the die: what was thrown, or the distance a power substituted for it. */
  readonly face: number;
  /**
   * The main move this settles into, or null while powers are still having their say —
   * a die on the table with a question hanging over it.
   */
  readonly move: number | null;
  /** The move stands in place of the face (Alchemist) rather than adjusting it (Blimp). */
  readonly replaced: boolean;
  readonly modifiedBy?: RacerId | undefined;
  /** Shown without the tumble, e.g. under reduced motion. */
  readonly instant: boolean;
}

type Step =
  | { readonly t: 'move'; readonly racer: RacerId; readonly to: number; readonly hop: boolean }
  | { readonly t: 'throw'; readonly racer: RacerId; readonly value: number }
  | {
      readonly t: 'roll';
      readonly racer: RacerId;
      readonly value: number;
      readonly natural?: number | undefined;
      readonly replaced?: boolean | undefined;
      readonly modifiedBy?: RacerId | undefined;
    }
  | { readonly t: 'turn' };

function truth(message: StateMessage | null): Positions {
  const out: Record<string, number> = {};
  for (const r of message?.view.board ?? []) out[r.racerId] = r.pos;
  return out;
}

/**
 * Folds a settled main move into the die already on the table, when it is that die's own
 * result — so the number the player watched land stays put and only the label grows. A
 * replaced main move (Legs jogging a fixed 5) never threw anything, so it gets a die of
 * its own.
 */
function settle(
  prev: ShownRoll | null,
  step: Extract<Step, { t: 'roll' }>,
  key: number,
  instant: boolean,
): ShownRoll {
  const face = step.natural ?? step.value;
  const settled = {
    move: step.value,
    replaced: step.replaced ?? false,
    modifiedBy: step.modifiedBy,
  };
  if (prev && prev.racerId === step.racer && prev.move === null && prev.face === face) {
    return { ...prev, ...settled };
  }
  return { key, racerId: step.racer, face, ...settled, instant };
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
 * A `dice/thrown` event queues a pause for the die to tumble and land, so everyone sees the
 * face before anything reacts to it — including the powers that ask a question about it.
 * The `dice/rolled` that follows fills in the move that face settled into. The die is cleared when the next turn begins: a roll
 * belongs to the turn that made it, and leaving it lingering over the infield reads as part
 * of the turn now starting.
 *
 * Honours `prefers-reduced-motion` by skipping the replay entirely; the die then just shows
 * the latest roll.
 */
export function useBoardPositions(client: RoomClient, message: StateMessage | null): BoardAnimation {
  const [positions, setPositions] = useState<Positions>(() => truth(message));
  const [animating, setAnimating] = useState(false);
  const [roll, setRoll] = useState<ShownRoll | null>(null);
  // Mirrors `roll`, so the drain can read what is on the table without waiting for React.
  const shown = useRef<ShownRoll | null>(null);
  const rollKey = useRef(0);
  const queue = useRef<Step[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(message);
  latest.current = message;

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    const show = (next: ShownRoll | null): void => {
      shown.current = next;
      setRoll(next);
    };

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
      } else if (next.t === 'throw') {
        show({
          key: ++rollKey.current,
          racerId: next.racer,
          face: next.value,
          move: null,
          replaced: false,
          instant: false,
        });
        // Long enough for the die to come to rest — and if a power is about to ask about
        // it, the question waits behind this.
        delay = queue.current.length > BACKLOG_FAST ? HOP_FAST_MS : ROLL_TUMBLE_MS;
      } else if (next.t === 'roll') {
        const before = shown.current;
        show(settle(before, next, ++rollKey.current, false));
        const fresh = shown.current?.key !== before?.key;
        // A long backlog means a burst of powers; don't make it longer.
        delay =
          queue.current.length > BACKLOG_FAST
            ? HOP_FAST_MS
            : fresh
              ? ROLL_TUMBLE_MS + ROLL_HOLD_MS
              : ROLL_HOLD_MS;
      } else {
        show(null);
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
        // Same bookkeeping as the animated path, just without the waiting: the die ends up
        // wherever this batch of events leaves it, and a new turn clears it.
        let next = shown.current;
        for (const e of events) {
          if (e.t === 'turn/began' || e.t === 'race/started') next = null;
          else if (e.t === 'dice/thrown') {
            next = {
              key: ++rollKey.current,
              racerId: e.racerId,
              face: e.value,
              move: null,
              replaced: false,
              instant: true,
            };
          } else if (e.t === 'dice/rolled') {
            next = settle(
              next,
              {
                t: 'roll',
                racer: e.racerId,
                value: e.value,
                natural: e.natural,
                replaced: e.replaced,
                modifiedBy: e.modifiedBy,
              },
              ++rollKey.current,
              true,
            );
          }
        }
        show(next);
        return;
      }

      for (const e of events) {
        if (e.t === 'race/started') {
          // A new race: everyone is back on Start. Drop any stale hops from the last race.
          queue.current = [];
          show(null);
        } else if (e.t === 'dice/thrown') {
          queue.current.push({ t: 'throw', racer: e.racerId, value: e.value });
        } else if (e.t === 'dice/rolled') {
          queue.current.push({
            t: 'roll',
            racer: e.racerId,
            value: e.value,
            natural: e.natural,
            replaced: e.replaced,
            modifiedBy: e.modifiedBy,
          });
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
