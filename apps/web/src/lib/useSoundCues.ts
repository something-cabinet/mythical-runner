import { useEffect } from 'react';
import type { RoomClient } from './roomClient';
import { play } from './sound';

/**
 * Sounds for everything outside the race itself: people arriving, the draft, the start of a
 * race and the end of the game. The race's own cues play from the board animation queue
 * (`useBoardPositions`) so they line up with what is drawn.
 */
export function useSoundCues(client: RoomClient): void {
  useEffect(() => {
    return client.onEvents((events, msg) => {
      if (document.hidden) return;
      const you = msg.view.you;
      for (const e of events) {
        if (e.t === 'player/joined' && e.player !== you) play('join');
        else if (e.t === 'draft/rolled') play('throw');
        else if (e.t === 'draft/picked') play('pick');
        else if (e.t === 'race/started') play('raceStart');
        else if (e.t === 'game/ended') play(e.winners.includes(you) ? 'win' : 'gameOver');
      }
    });
  }, [client]);
}
