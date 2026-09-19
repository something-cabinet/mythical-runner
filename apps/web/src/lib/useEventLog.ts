import { useEffect, useRef, useState } from 'react';
import { describeEvent, playerName, racerName, type LogLine } from './present';
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
 *
 * Each turn opens with a numbered divider, so a busy turn's powers read as one block. A
 * divider stays up with nothing under it while that turn is still being played, but one
 * left empty when the next turn starts is dropped rather than shown as a dead heading.
 */
export function useEventLog(client: RoomClient): NumberedLine[] {
  const [lines, setLines] = useState<NumberedLine[]>([]);
  const counter = useRef(0);
  const turnNo = useRef(0);

  useEffect(() => {
    return client.onEvents((events, msg) => {
      if (events.length === 0) return;
      let fresh: NumberedLine[] = [];
      let reset = false;
      for (const e of events) {
        if (e.t === 'race/started') {
          reset = true;
          fresh = [];
          turnNo.current = 0;
        }
        if (e.t === 'turn/began') {
          if (fresh.at(-1)?.tone === 'divider') fresh.pop();
          const who = playerName(msg.view, e.player);
          const text = `Turn ${++turnNo.current} · ${e.racerId ? `${racerName(msg.view, e.racerId)} (${who})` : who}`;
          fresh.push({ text, tone: 'divider', id: counter.current++ });
          continue;
        }
        const line = describeEvent(e, msg.view);
        if (line) fresh.push({ ...line, id: counter.current++ });
      }
      if (fresh.length === 0 && !reset) return;
      const opensWithTurn = fresh[0]?.tone === 'divider';
      fresh.reverse();
      setLines((prev) => {
        const kept = reset ? [] : opensWithTurn && prev[0]?.tone === 'divider' ? prev.slice(1) : prev;
        return [...fresh, ...kept].slice(0, 150);
      });
    });
  }, [client]);

  return lines;
}
