import {
  currentDrafter,
  racerName,
  racerText,
  RACE_AWARDS,
  totalPoints,
  type GameEvent,
  type PlayerId,
  type PlayerView,
  type RacerId,
  type RaceNumber,
} from '@mr/engine';

/**
 * Display helpers. Everything here is a pure function of a `PlayerView`, so components can
 * call them freely and nothing needs memoising for correctness.
 */

/**
 * Six seat colours, one per possible player.
 *
 * Chosen to stay distinguishable from each other in both themes and for the common forms
 * of colour blindness — hue differences are backed by clear lightness differences — and
 * every token also carries initials, so colour is never the only cue.
 */
export const SEAT_COLORS = ['#ff6b5a', '#35c6be', '#ffc53d', '#9a8cff', '#72d05c', '#ff7fc8'] as const;

/** Text colour that reads on each seat colour. All six are light enough for dark text. */
export const SEAT_INK = '#1a1523';

export function seatIndex(view: PlayerView, pid: PlayerId): number {
  const order = view.seatOrder.length > 0 ? view.seatOrder : view.players.map((p) => p.id);
  return Math.max(0, order.indexOf(pid));
}

export function seatColor(view: PlayerView, pid: PlayerId): string {
  return SEAT_COLORS[seatIndex(view, pid) % SEAT_COLORS.length] ?? SEAT_COLORS[0];
}

export function playerName(view: PlayerView, pid: PlayerId): string {
  if (pid === view.you) return 'You';
  return view.players.find((p) => p.id === pid)?.name ?? 'Someone';
}

/** The player's own chosen name, never "You". For lists where every row needs a name. */
export function rawName(view: PlayerView, pid: PlayerId): string {
  return view.players.find((p) => p.id === pid)?.name ?? 'Someone';
}

export function initials(name: string): string {
  // "Racer 13" and "Racer 15" would both be "R1"; a trailing number is the distinguishing
  // part, so use it.
  const numbered = /(\d+)\s*$/.exec(name);
  if (numbered?.[1]) return numbered[1].slice(-2);
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '?').slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

export function racerInitials(id: RacerId): string {
  return initials(racerName(id));
}

export { racerName, racerText };

/** Placeholder racers have no power yet; the UI says so rather than showing a blank. */
export function powerText(id: RacerId): string {
  return racerText(id) || 'No power yet — this racer just runs.';
}

export function points(view: PlayerView, pid: PlayerId): number {
  return totalPoints(view.scores[pid] ?? []);
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function trackLabel(raceNo: RaceNumber): string {
  return raceNo % 2 === 1 ? 'Mild Mile' : 'Wild Wilds';
}

export function awardsFor(raceNo: RaceNumber): { gold: number; silver: number } {
  return RACE_AWARDS[raceNo];
}

/**
 * Whose input the table is currently waiting on.
 *
 * Drives both the countdown label and the "your turn" highlight. A pending decision
 * outranks everything, because nothing else can happen until it is answered — and the
 * person answering is often not the active player.
 */
export function waitingOn(view: PlayerView): PlayerId[] {
  if (view.pending) return [view.pending.player];
  const phase = view.phase;
  switch (phase.t) {
    case 'draftRoll':
      return (Object.entries(phase.rolls) as [PlayerId, number | null][])
        .filter(([, v]) => v === null)
        .map(([p]) => p);
    case 'draft':
      return [currentDrafter(phase.order, phase.pick)];
    case 'commit':
      return view.seatOrder.filter((p) => !phase.committedBy.includes(p));
    case 'racing':
      return [phase.active];
    default:
      return [];
  }
}

export function listNames(view: PlayerView, pids: readonly PlayerId[]): string {
  const names = pids.map((p) => playerName(view, p));
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export interface LogLine {
  readonly text: string;
  readonly tone: 'plain' | 'good' | 'bad' | 'power' | 'turn';
}

/**
 * Turns an engine event into a line for the race log, or null for events too noisy to list.
 *
 * `racer/moved` is always null: it fires once per space travelled and the board already
 * shows it. The log is for things a player would otherwise miss — passes, trips, powers.
 */
export function describeEvent(e: GameEvent, view: PlayerView): LogLine | null {
  const who = (pid: PlayerId): string => playerName(view, pid);
  const racer = (id: RacerId): string => racerName(id);

  switch (e.t) {
    case 'player/joined':
      return { text: `${who(e.player)} joined`, tone: 'plain' };
    case 'player/left':
      return { text: `${who(e.player)} left`, tone: 'plain' };
    case 'game/started':
      return { text: 'The game has started', tone: 'turn' };
    case 'draft/rolled':
      return { text: `${who(e.player)} rolled ${e.value} for draft order`, tone: 'plain' };
    case 'draft/orderSet':
      return { text: `${who(e.order[0] as PlayerId)} drafts first`, tone: 'turn' };
    case 'draft/picked':
      return { text: `${who(e.player)} drafted ${racer(e.racerId)}`, tone: 'plain' };
    case 'race/started':
      return { text: `Race ${e.raceNo} begins on the ${trackLabel(e.raceNo)}`, tone: 'turn' };
    case 'race/revealed':
      return {
        text: e.picks.map((p) => `${who(p.player)}: ${racer(p.racerId)}`).join(' · '),
        tone: 'plain',
      };
    case 'turnOrder/set':
      return {
        text:
          e.reason === 'trailing'
            ? `${who(e.first)} ${e.first === view.you ? 'go' : 'goes'} first — farthest behind last race`
            : `${who(e.first)} won the roll-off and ${e.first === view.you ? 'go' : 'goes'} first`,
        tone: 'turn',
      };
    case 'turn/began':
      return null;
    case 'dice/rolled':
      return { text: `${racer(e.racerId)} moves ${e.value}`, tone: 'plain' };
    case 'racer/passed':
      return { text: `${racer(e.racerId)} passes ${racer(e.passed)}`, tone: 'plain' };
    case 'racer/warped':
      return { text: `${racer(e.racerId)} warps to space ${e.to}`, tone: 'power' };
    case 'racer/tripped':
      return { text: `${racer(e.racerId)} trips!`, tone: 'bad' };
    case 'racer/stoodUp':
      return { text: `${racer(e.racerId)} gets back up`, tone: 'plain' };
    case 'racer/eliminated':
      return { text: `${racer(e.racerId)} is out of the race!`, tone: 'bad' };
    case 'ability/triggered':
      return { text: e.text, tone: 'power' };
    case 'decision/requested':
      return null;
    case 'decision/made':
      return {
        text: `${who(e.player)} chose “${e.label}”${e.auto ? ' (out of time)' : ''}`,
        tone: 'plain',
      };
    case 'token/awarded':
      return {
        text:
          e.token.kind === 'points'
            ? `${who(e.player)} ${e.player === view.you ? 'get' : 'gets'} ${e.token.value} point${e.token.value === 1 ? '' : 's'}`
            : `${who(e.player)} ${e.player === view.you ? 'take' : 'takes'} the ${e.token.kind} cup (${e.token.value})`,
        tone: 'good',
      };
    case 'token/lost':
      return {
        text: `${who(e.player)} ${e.player === view.you ? 'lose' : 'loses'} ${e.value} point${e.value === 1 ? '' : 's'}`,
        tone: 'bad',
      };
    case 'racer/finished':
      return { text: `${racer(e.racerId)} crosses the line ${ordinal(e.rank)}!`, tone: 'good' };
    case 'race/ended':
      return {
        text: e.byStalemate ? `Race ${e.raceNo} ends in a stalemate` : `Race ${e.raceNo} is over`,
        tone: 'turn',
      };
    case 'game/ended':
      return { text: 'The game is over', tone: 'turn' };
    case 'turnOrder/rolled':
    case 'racer/moved':
      return null;
  }
}
