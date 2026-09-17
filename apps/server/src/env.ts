import type { RoomDO } from './room.js';

export interface Env {
  readonly ROOMS: DurableObjectNamespace<RoomDO>;
}
