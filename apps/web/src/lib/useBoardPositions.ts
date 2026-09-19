import type { GameEvent, RacerId, StateMessage } from '@mr/engine';
import { useEffect, useRef, useState } from 'react';
import type { RoomClient } from './roomClient';
import { play, type Sound } from './sound';

type Positions = Readonly<Record<string, number>>;

/** Milliseconds per space. Short enough to keep a turn snappy, long enough to follow. */
const HOP_MS = 170;
/** A burst of powers can queue dozens of hops; past this, play faster so turns don't drag. */
const BACKLOG_FAST = 24;
const HOP_FAST_MS = 60;
/** How long the die tumbles, then how long the result sits before the racer moves. */
export const ROLL_TUMBLE_MS = 650;
const ROLL_HOLD_MS = 550;
/** How long a power holds the queue so everyone sees who just did something. */
const POWER_MS = 450;
/**
 * A power that also fired last turn (Gunk gooping every mover) is old news: it still
 * flashes, but barely holds anything up.
 */
const POWER_REPEAT_MS = 150;
/** How long the callout for a power stays up. Matches the `power-callout` animation. */
export const POWER_SHOW_MS = 1800;

/** The power that just happened, for the board to call out. */
export interface ShownPower {
  /** Changes with every power, so the burst and callout replay. */
  readonly key: number;
  readonly racerId: RacerId;
  readonly text: string;
  /** Shown without animation, e.g. under reduced motion. */
  readonly instant: boolean;
}

/** The most recent roll, for the board to show as a die. */
export interface ShownRoll {
  /** Changes with every throw, so the die remounts and tumbles again. */
  readonly key: number;
  readonly racerId: RacerId;
  /** The face on the die: what was thrown, or the distance a power substituted for it. */
  readonly face: number;
  /** Sides of the die it came off, or of each die when several were combined — see `DiceThrown`. */
  readonly die: number;
  /** Each die's face, when several were thrown and combined into `face` (Ogre Magi). */
  readonly dice?: readonly number[] | undefined;
  /**
   * The main move this settles into, or null while powers are still having their say —
   * a die on the table with a question hanging over it.
   */
  readonly move: number | null;
  /** The move stands in place of the face (Alchemist) rather than adjusting it (Blimp). */
  readonly replaced: boolean;
  readonly modifiedBy?: RacerId | undefined;
  /** The racer whose power asked for this roll (Pudge's hook, a duel), when it isn't a main move. */
  readonly power?: RacerId | undefined;
  /** Shown without the tumble, e.g. under reduced motion. */
  readonly instant: boolean;
}

type Step =
  | { readonly t: 'move'; readonly racer: RacerId; readonly to: number; readonly hop: boolean }
  | {
      readonly t: 'throw';
      readonly racer: RacerId;
      readonly value: number;
      readonly die: number;
      readonly dice?: readonly number[] | undefined;
      readonly power?: RacerId | undefined;
    }
  | {
      readonly t: 'roll';
      readonly racer: RacerId;
      readonly value: number;
      readonly natural?: number | undefined;
      readonly replaced?: boolean | undefined;
      readonly modifiedBy?: RacerId | undefined;
    }
  | { readonly t: 'power'; readonly racer: RacerId; readonly text: string }
  | { readonly t: 'mark'; readonly apply: (d: Drawn) => Drawn }
  | { readonly t: 'turn' }
  | { readonly t: 'cue'; readonly sound: Sound };

/**
 * The sound a race event makes, if any. Played from the queue rather than on arrival, so a
 * trip is heard when it is drawn, not while the racer is still walking towards the banana.
 */
function cueFor(e: GameEvent, you: string | undefined): Sound | null {
  switch (e.t) {
    case 'turn/began':
      return e.player === you ? 'yourTurn' : null;
    case 'decision/requested':
      return e.player === you ? 'decision' : null;
    case 'racer/tripped':
      return 'trip';
    case 'racer/eliminated':
      return 'eliminated';
    case 'ability/triggered':
      return 'ability';
    case 'racer/finished':
      return e.player === you ? 'finishMine' : 'finish';
    default:
      return null;
  }
}

function truth(message: StateMessage | null): Positions {
  const out: Record<string, number> = {};
  for (const r of message?.view.board ?? []) out[r.racerId] = r.pos;
  return out;
}

/**
 * Everything the board draws that can change mid-turn, as it should look right now. Each
 * part lags the true state the same way positions do, so a racer isn't shown tripped, a
 * mine isn't laid and a star isn't taken until the racer is seen to get there.
 */
interface Drawn {
  readonly positions: Positions;
  readonly tripped: readonly RacerId[];
  readonly eliminated: readonly RacerId[];
  /** Techies' mines. */
  readonly tripSpaces: readonly number[];
  /** Stars already taken this race. */
  readonly claimedSpaces: readonly number[];
}

function drawnTruth(message: StateMessage | null): Drawn {
  const board = message?.view.board ?? [];
  const phase = message?.view.phase;
  const racing = phase?.t === 'racing' ? phase : null;
  return {
    positions: truth(message),
    tripped: board.filter((r) => r.tripped).map((r) => r.racerId),
    eliminated: board.filter((r) => r.eliminated).map((r) => r.racerId),
    tripSpaces: racing?.tripSpaces ?? [],
    claimedSpaces: racing?.claimedSpaces ?? [],
  };
}

function withItem<T>(list: readonly T[], item: T, on: boolean): readonly T[] {
  if (list.includes(item) === on) return list;
  return on ? [...list, item] : list.filter((x) => x !== item);
}

/** How an event changes what is drawn, beyond moving a racer. */
function markFor(e: GameEvent): ((d: Drawn) => Drawn) | null {
  switch (e.t) {
    case 'racer/tripped':
      return (d) => ({ ...d, tripped: withItem(d.tripped, e.racerId, true) });
    case 'racer/stoodUp':
      return (d) => ({ ...d, tripped: withItem(d.tripped, e.racerId, false) });
    case 'racer/eliminated':
      return (d) => ({ ...d, eliminated: withItem(d.eliminated, e.racerId, true) });
    case 'space/mined':
      return (d) => ({ ...d, tripSpaces: withItem(d.tripSpaces, e.pos, true) });
    case 'space/claimed':
      return (d) => ({ ...d, claimedSpaces: withItem(d.claimedSpaces, e.pos, true) });
    default:
      return null;
  }
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
  return { key, racerId: step.racer, face, die: 6, ...settled, instant };
}

export interface BoardAnimation {
  /** Where to draw each racer right now. */
  readonly positions: Positions;
  /** Who to draw tripped, out, mined and taken — see `Drawn`. */
  readonly tripped: readonly RacerId[];
  readonly eliminated: readonly RacerId[];
  readonly tripSpaces: readonly number[];
  readonly claimedSpaces: readonly number[];
  /** True while queued moves are still playing out. */
  readonly animating: boolean;
  readonly roll: ShownRoll | null;
  readonly power: ShownPower | null;
}

/**
 * Whether an event is a racer's own power going off. Arrow spaces log through the same
 * event, but a space shoving a racer is the track, not the racer.
 */
function isPower(e: GameEvent): e is Extract<GameEvent, { t: 'ability/triggered' }> {
  return e.t === 'ability/triggered' && e.hook !== 'space';
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
 *  - Tripping, standing up, elimination, Techies' mines and taken stars are queued the same
 *    way, so none of them shows before the racer is seen to get there.
 *  - Once the queue drains, everything resets to the authoritative board. Some relocations
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
 * An `ability/triggered` queues a short beat too, so a power is seen going off where it
 * happens in the turn — see `POWER_MS`.
 *
 * Honours `prefers-reduced-motion` by skipping the replay entirely; the die then just shows
 * the latest roll, and the last power in the batch is called out without animation.
 */
export function useBoardPositions(client: RoomClient, message: StateMessage | null): BoardAnimation {
  const [drawn, setDrawn] = useState<Drawn>(() => drawnTruth(message));
  const [animating, setAnimating] = useState(false);
  const [roll, setRoll] = useState<ShownRoll | null>(null);
  const [power, setPower] = useState<ShownPower | null>(null);
  const powerKey = useRef(0);
  const powerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Turns since the race began, and the last turn each racer's power flashed on.
  const turnNo = useRef(0);
  const flashedOn = useRef(new Map<RacerId, number>());
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

    const callOut = (racerId: RacerId, text: string, instant: boolean): void => {
      setPower({ key: ++powerKey.current, racerId, text, instant });
      if (powerTimer.current) clearTimeout(powerTimer.current);
      powerTimer.current = setTimeout(() => setPower(null), POWER_SHOW_MS);
    };

    const drain = (): void => {
      timer.current = null;
      const next = queue.current.shift();
      if (!next) {
        setDrawn(drawnTruth(latest.current));
        setAnimating(false);
        return;
      }
      let delay = 0;
      if (next.t === 'move') {
        setDrawn((prev) => ({ ...prev, positions: { ...prev.positions, [next.racer]: next.to } }));
        if (next.hop) play('hop');
        delay = !next.hop ? 0 : queue.current.length > BACKLOG_FAST ? HOP_FAST_MS : HOP_MS;
      } else if (next.t === 'mark') {
        setDrawn(next.apply);
      } else if (next.t === 'cue') {
        play(next.sound);
      } else if (next.t === 'power') {
        play('ability');
        callOut(next.racer, next.text, false);
        const last = flashedOn.current.get(next.racer);
        const repeat = last !== undefined && last >= turnNo.current - 1;
        flashedOn.current.set(next.racer, turnNo.current);
        delay = queue.current.length > BACKLOG_FAST ? HOP_FAST_MS : repeat ? POWER_REPEAT_MS : POWER_MS;
      } else if (next.t === 'throw') {
        play('throw');
        show({
          key: ++rollKey.current,
          racerId: next.racer,
          face: next.value,
          die: next.die,
          dice: next.dice,
          move: null,
          replaced: false,
          power: next.power,
          instant: false,
        });
        // Long enough for the die to come to rest — and if a power is about to ask about
        // it, the question waits behind this. A power's roll has no move to settle into, so
        // the face gets its own moment before whatever it decides plays out.
        delay =
          queue.current.length > BACKLOG_FAST
            ? HOP_FAST_MS
            : next.power
              ? ROLL_TUMBLE_MS + ROLL_HOLD_MS
              : ROLL_TUMBLE_MS;
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
        turnNo.current++;
        show(null);
      }
      timer.current = setTimeout(drain, delay);
    };

    const onEvents = (events: readonly GameEvent[], msg: StateMessage): void => {
      if (reduced.matches || document.hidden) {
        queue.current = [];
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setDrawn(drawnTruth(latest.current));
        setAnimating(false);
        // Nobody is looking at a hidden tab. Under reduced motion there is no replay to
        // sync with, so each distinct cue in the batch plays once, straight away.
        if (!document.hidden) {
          const you = msg.view.you;
          const cues = new Set(events.map((e) => cueFor(e, you)));
          for (const cue of cues) if (cue) play(cue);
        }
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
              die: e.die ?? 6,
              dice: e.dice,
              move: null,
              replaced: false,
              power: e.power,
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
        const lastPower = events.filter(isPower).at(-1);
        if (lastPower && !document.hidden) callOut(lastPower.racerId, lastPower.text, true);
        return;
      }

      const you = msg.view.you;
      for (const e of events) {
        const cue = cueFor(e, you);
        if (e.t === 'race/started') {
          // A new race: everyone is back on Start. Drop any stale hops from the last race.
          queue.current = [];
          setDrawn((prev) => ({ ...prev, tripped: [], eliminated: [], tripSpaces: [], claimedSpaces: [] }));
          show(null);
          turnNo.current = 0;
          flashedOn.current.clear();
        } else if (isPower(e)) {
          // Plays its own sound, so it takes the place of the cue.
          queue.current.push({ t: 'power', racer: e.racerId, text: e.text });
          continue;
        } else if (e.t === 'dice/thrown') {
          queue.current.push({ t: 'throw', racer: e.racerId, value: e.value, die: e.die ?? 6, dice: e.dice, power: e.power });
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
        } else {
          const apply = markFor(e);
          if (apply) queue.current.push({ t: 'mark', apply });
        }
        if (cue) queue.current.push({ t: 'cue', sound: cue });
      }

      if (queue.current.length === 0) {
        if (!timer.current) setDrawn(drawnTruth(latest.current));
      } else if (!timer.current) {
        setAnimating(true);
        drain();
      }
    };

    const off = client.onEvents(onEvents);
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      if (powerTimer.current) clearTimeout(powerTimer.current);
      timer.current = null;
      queue.current = [];
    };
  }, [client]);

  // Racers joining or leaving the board (a new race, a reconnect snapshot) must show up
  // even when no animation is running.
  const boardKey = (message?.view.board ?? []).map((r) => r.racerId).join('|');
  useEffect(() => {
    if (!timer.current && queue.current.length === 0) setDrawn(drawnTruth(latest.current));
  }, [boardKey]);

  return { ...drawn, animating, roll, power };
}
