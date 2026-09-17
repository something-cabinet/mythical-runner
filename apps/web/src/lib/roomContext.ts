import type { ClientAction, PlayerView, StateMessage } from '@mr/engine';
import { createContext, useContext } from 'react';
import type { RoomClient, RoomSnapshot } from './roomClient';
import type { BoardAnimation } from './useBoardPositions';
import type { NumberedLine } from './useEventLog';

export interface RoomContextValue {
  readonly code: string;
  readonly client: RoomClient;
  readonly snapshot: RoomSnapshot;
  readonly message: StateMessage;
  readonly view: PlayerView;
  /** False while an action is in flight or the socket is down. */
  readonly canAct: boolean;
  readonly send: (action: ClientAction) => void;
  /** The race log, newest first. Lives for the whole connection. */
  readonly log: readonly NumberedLine[];
  /** Animated board positions. Lives for the whole connection. */
  readonly board: BoardAnimation;
}

export const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoomContext(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error('useRoomContext outside a connected room');
  return ctx;
}

/** Legal actions of one type. The server computed these; the client never re-derives them. */
export function legalOf<T extends ClientAction['t']>(
  message: StateMessage,
  t: T,
): Extract<ClientAction, { t: T }>[] {
  return message.legal.filter((a): a is Extract<ClientAction, { t: T }> => a.t === t);
}
