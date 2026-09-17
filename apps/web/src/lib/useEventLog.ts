import { useEffect, useRef, useState } from 'react';
import { describeEvent, type LogLine } from './present';
import type { RoomClient } from './roomClient';

export interface NumberedLine extends LogLine {
  readonly id: number;
}

/**
 * The race log, newest first.
 *
 * Subscribed for the whole life of the connection, not by the race screen. The message
 * that *switches* to the race screen is the one carrying "race begins", the reveals and who
 * goes first; a log owned by that screen would subscribe one message too late and always
 * miss them.
 *
 * Built from events rather than state, because events are the only record of *why* things
 * moved. Resets at the start of each race. Empty after a reconnect, which sends a snapshot.
 */
export function useEventLog(client: RoomClient): NumberedLine[] {
  const [lines, setLines] = useState<NumberedLine[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    return client.onEvents((events, msg) => {
      if (events.length === 0) return;
      let fresh: NumberedLine[] = [];
      let reset = false;
      for (const e of events) {
        if (e.t === 'race/started') {
          reset = true;
          fresh = [];
        }
        const line = describeEvent(e, msg.view);
        if (line) fresh.push({ ...line, id: counter.current++ });
      }
      if (fresh.length === 0 && !reset) return;
      fresh.reverse();
      setLines((prev) => [...fresh, ...(reset ? [] : prev)].slice(0, 150));
    });
  }, [client]);

  return lines;
}
