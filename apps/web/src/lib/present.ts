import {
  CHARACTER_SETS,
  currentDrafter,
  racerLabel,
  racerName as bareRacerName,
  racerText,
  powerOf,
  copyTarget,
  leashesOf,
  LEASH,
  SOULBIND,
  RACE_AWARDS,
  totalPoints,
  type CharacterSetId,
  type GameEvent,
  type PlayerId,
  type PlayerView,
  type RacerId,
  type RaceNumber,
  type RacerState,
  type Soulbind,
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
  return initials(bareRacerName(id));
}

/**
 * Racer art, keyed by racer id, under `apps/web/public/character_sprite`. Each character
 * set has its own folder there; the placeholder sits above them, shared by all of them.
 *
 * Only the racers whose art has been drawn are listed; the rest fall back to the
 * placeholder, so a new racer never renders a broken image. Paths are listed explicitly
 * rather than derived from the id and set, because the art is hand-authored and its names
 * do not all match the ids, nor are they all PNGs (`lovable-loser` is a JPEG named
 * `loveableLoser`).
 *
 * To add art: drop the file in its set's folder and add one line here.
 */
const SPRITE_FILES: Readonly<Record<string, string>> = {
  banana: 'classic/banana.png',
  dicemonger: 'classic/dicemonger.png',
  duelist: 'classic/duelist.png',
  hare: 'classic/hare.png',
  heckler: 'classic/heckler.png',
  hypnotist: 'classic/hypnotist.png',
  'lovable-loser': 'classic/loveableLoser.jpg',
  romantic: 'classic/romantic.png',

  // The Dota set: Valve's own hero portraits (`heroes/<name>_full.png`, the art Dotabuff
  // shows as its hero avatar), the middle 144x144 of the 256x144 image, so the disc's
  // circular clip lands on the face.
  'anti-mage': 'dota2/anti-mage.png',
  'bounty-hunter': 'dota2/bounty-hunter.png',
  'dota-alchemist': 'dota2/dota-alchemist.png',
  earthshaker: 'dota2/earthshaker.png',
  'faceless-void': 'dota2/faceless-void.png',
  kunkka: 'dota2/kunkka.png',
  'legion-commander': 'dota2/legion-commander.png',
  morphling: 'dota2/morphling.png',
  'ogre-magi': 'dota2/ogre-magi.png',
  omniknight: 'dota2/omniknight.png',
  oracle: 'dota2/oracle.png',
  silencer: 'dota2/silencer.png',
  'spirit-breaker': 'dota2/spirit-breaker.png',
  'storm-spirit': 'dota2/storm-spirit.png',
  'templar-assassin': 'dota2/templar-assassin.png',
  tidehunter: 'dota2/tidehunter.png',
  bloodseeker: 'dota2/bloodseeker.png',
  clockwerk: 'dota2/clockwerk.png',
  pudge: 'dota2/pudge.png',
  techies: 'dota2/techies.png',
  'chaos-knight': 'dota2/chaos-knight.png',
  abaddon: 'dota2/abaddon.png',
  'ember-spirit': 'dota2/ember-spirit.png',
  'earth-spirit': 'dota2/earth-spirit.png',
  bristleback: 'dota2/bristleback.png',
  // Valve's `_full` art for Drow is still a 128x72 original; this is the same picture from
  // `heroes/drow_ranger_lg.png` (204x115), cropped the same way.
  'drow-ranger': 'dota2/drow-ranger.png',
  'night-stalker': 'dota2/night-stalker.png',
  slark: 'dota2/slark.png',
  'void-spirit': 'dota2/void-spirit.png',
  lich: 'dota2/lich.png',
  magnus: 'dota2/magnus.png',
  underlord: 'dota2/underlord.png',
  doom: 'dota2/doom.png',
  sven: 'dota2/sven.png',
  kez: 'dota2/kez.png',
  invoker: 'dota2/invoker.png',
  largo: 'dota2/largo.png',
  juggernaut: 'dota2/juggernaut.png',
  lina: 'dota2/lina.png',
  'phantom-assassin': 'dota2/phantom-assassin.png',
  tusk: 'dota2/tusk.png',
  grimstroke: 'dota2/grimstroke.png',
};

const SPRITE_DIR = '/character_sprite';
const PLACEHOLDER_SPRITE = `${SPRITE_DIR}/placeholder.png`;

/** The image for a racer, or the placeholder when that racer has no art yet. */
export function racerSprite(id: RacerId): string {
  const path = SPRITE_FILES[id];
  return path ? `${SPRITE_DIR}/${path}` : PLACEHOLDER_SPRITE;
}

/** True when `racerSprite` is a real likeness rather than the stand-in. */
export function hasSprite(id: RacerId): boolean {
  return id in SPRITE_FILES;
}

/**
 * A racer's name as this game should show it.
 *
 * Racer names are only unique within a set — the classic set and the Dota set both field
 * an Alchemist — so once the lobby mixes sets every racer carries its set, "Genius
 * (Classic)" next to "Morphling (Dota)". With one set in play the bare name is shown.
 *
 * Takes the view rather than being a bare lookup for that reason, like `playerName`.
 */
export function racerName(view: PlayerView, id: RacerId): string {
  return racerLabel(id, view.racerSets);
}

export { racerText };

/**
 * Whose card a racer is actually running, or null when it is running its own.
 *
 * Egg and Twin borrow a power for the whole race; Copy Cat has whoever leads right now,
 * and Morphling whoever is last.
 * The lists show the borrowed card, since that — not the name on the token — is what the
 * racer will actually do.
 */
export function borrowedPower(view: PlayerView, racer: RacerState): RacerId | null {
  const power = powerOf(racer);
  if (power !== racer.racerId) return power;
  return copyTarget(view, racer);
}

/**
 * A limited-use power's remaining charges or cooldown, for the lists: Templar Assassin's
 * Refraction, Silencer's Global Silence, and the cooldowns on Faceless Void's Chronosphere,
 * Storm Spirit's d20 and Sven's God's Strength. Null for every other card.
 *
 * `power` is the card the racer is running (see `borrowedPower`), so a Morphling borrowing
 * one shows it too. The counts come from the same `memo` keys the powers write.
 */
export function abilityToken(
  racer: RacerState,
  power: RacerId,
): { label: string; ready: boolean; title: string } | null {
  switch (power as string) {
    case 'templar-assassin': {
      const used = typeof racer.memo['refractions'] === 'number' ? (racer.memo['refractions'] as number) : 0;
      const left = Math.max(0, 3 - used);
      return { label: `refraction ${left}/3`, ready: left > 0, title: `Refraction: ignores the next ${left} trips` };
    }
    case 'faceless-void':
      return cooldownToken(racer, 'chrono', 'chrono', 'Chronosphere');
    case 'storm-spirit':
      return cooldownToken(racer, 'overload', 'd20', 'Overload (d20)');
    case 'juggernaut':
      return cooldownToken(racer, 'omnislash', 'omnislash', 'Omnislash');
    case 'grimstroke':
      return cooldownToken(racer, 'soulbind', 'soulbind', 'Soulbind');
    case 'lina': {
      const stacks = typeof racer.memo['fierySoul'] === 'number' ? (racer.memo['fierySoul'] as number) : 0;
      return {
        label: `fiery soul ${stacks}/8`,
        ready: stacks >= 2,
        title: `Fiery Soul: ${stacks} stack${stacks === 1 ? '' : 's'}, +${Math.floor(stacks / 2)} to her main move`,
      };
    }
    case 'sven': {
      const active = timerOf(racer, 'strength');
      if (active > 0) {
        return {
          label: `strength ${active}`,
          ready: true,
          title: `God's Strength: +3 for ${active === 1 ? 'this turn' : `${active} more turns`}`,
        };
      }
      return cooldownToken(racer, 'strengthCooldown', 'strength', "God's Strength");
    }
    case 'silencer': {
      const used = racer.memo['silenceUsed'] === true;
      return {
        label: used ? 'silence used' : 'silence ready',
        ready: !used,
        title: used ? 'Global Silence already used this race' : 'Global Silence ready (once per race)',
      };
    }
    default:
      return null;
  }
}

/** A racer's own-turn countdown `name` (see the engine's `TIMERS`), or 0 when it has run out. */
function timerOf(racer: RacerState, name: string): number {
  const timers = racer.memo['timers'] as Readonly<Record<string, number>> | undefined;
  return timers?.[name] ?? 0;
}

/** A cooldown badge: ready, or how many of the racer's turns until it is. */
function cooldownToken(
  racer: RacerState,
  timer: string,
  short: string,
  name: string,
): { label: string; ready: boolean; title: string } {
  const wait = timerOf(racer, timer);
  return wait > 0
    ? { label: `${short} in ${wait}`, ready: false, title: `${name} ready again in ${wait} ${wait === 1 ? 'turn' : 'turns'}` }
    : { label: `${short} ready`, ready: true, title: `${name} ready` };
}

/** Silencer's hush on a racer: how many of its own turns it has no powers for. Null when none. */
export function silencedToken(racer: RacerState): { label: string; title: string } | null {
  const v = racer.memo['silenced'];
  const turns = v === true ? 1 : typeof v === 'number' ? v : 0;
  if (turns <= 0) return null;
  return {
    label: `silenced ${turns}`,
    title: `Silenced: no powers for ${turns === 1 ? 'its next turn' : `its next ${turns} turns`}`,
  };
}

/**
 * A tie between two racers that the board draws as a tether: a rope from one piece to the
 * other, in `color`. `kind` picks the look (see `Tether`).
 */
export interface BoardLink {
  readonly key: string;
  readonly a: RacerId;
  readonly b: RacerId;
  readonly color: string;
  readonly kind: string;
  readonly title: string;
}

/**
 * Where each kind of link comes from. A new power that ties racers together adds a
 * source here and the board draws it; nothing else needs to change.
 */
const LINK_SOURCES: readonly ((view: PlayerView) => BoardLink[])[] = [
  // Grimstroke's Soulbind, in Grimstroke's seat colour.
  (view) =>
    view.board.flatMap((caster) => {
      const link = caster.memo[SOULBIND] as Soulbind | undefined;
      if (!link || caster.eliminated) return [];
      return [
        {
          key: `soulbind:${caster.racerId}`,
          a: link.a,
          b: link.b,
          color: seatColor(view, caster.owner),
          kind: 'soulbind',
          title: `${racerName(view, caster.racerId)}'s Soulbind: ${racerName(view, link.a)} and ${racerName(view, link.b)} can't get more than ${LEASH} spaces apart`,
        },
      ];
    }),
];

/** Every link to draw on the board: both ends still running. */
export function boardLinks(view: PlayerView): BoardLink[] {
  const running = (id: RacerId): boolean => {
    const r = view.board.find((x) => x.racerId === id);
    return r !== undefined && !r.eliminated && r.finishedRank === null;
  };
  return LINK_SOURCES.flatMap((source) => source(view)).filter((l) => running(l.a) && running(l.b));
}

/**
 * Grimstroke's Soulbind on a racer: who it can't stray more than 5 spaces from until the
 * caster's next turn. Null when it is bound to nobody.
 */
export function soulbindToken(view: PlayerView, racer: RacerState): { label: string; title: string } | null {
  const partners = leashesOf(view, racer).map(({ partner }) => racerName(view, partner.racerId));
  if (partners.length === 0) return null;
  return {
    label: 'soulbound',
    title: `Soulbound to ${partners.join(' and ')}: can't get more than ${LEASH} spaces apart`,
  };
}

/**
 * Legion Commander's duel prizes a racer holds: +1 to every main move for each duel won,
 * whoever won it — the Commander or the racer it challenged. Null when there are none.
 */
export function duelBonusToken(racer: RacerState): { label: string; title: string } | null {
  const bonus = racer.memo['mainMoveBonus'];
  if (typeof bonus !== 'number' || bonus === 0) return null;
  const duels = Math.abs(bonus);
  return {
    label: `duel ${bonus > 0 ? '+' : '−'}${duels}`,
    title: `Won ${duels} Legion Commander duel${duels === 1 ? '' : 's'}: ${bonus > 0 ? '+' : '−'}${duels} to every main move this race`,
  };
}

/** "Classic + Dota", in the sets' canonical order. */
export function setNames(sets: readonly CharacterSetId[]): string {
  return CHARACTER_SETS.filter((x) => sets.includes(x.id)).map((x) => x.name).join(' + ');
}

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

/** A player's place in the coming turns, with the racers they will move. */
export interface TurnSlot {
  readonly player: PlayerId;
  readonly racers: readonly RacerId[];
}

/**
 * Who goes when during a race, the player up now first, each player still racing listed
 * once. Mirrors the engine's hand-off: racers owed a turn out of order (Skipper's "I go next
 * in turn order") come first, then play continues clockwise from the last of them. Players
 * with nobody left running are skipped, as the engine skips them.
 */
export function turnOrder(view: PlayerView): TurnSlot[] {
  const phase = view.phase;
  if (phase.t !== 'racing') return [];
  const running = (pid: PlayerId): RacerId[] =>
    view.board.filter((r) => r.owner === pid && r.finishedRank === null && !r.eliminated).map((r) => r.racerId);

  const slots: TurnSlot[] = [{ player: phase.active, racers: running(phase.active) }];
  const listed = new Set<PlayerId>([phase.active]);
  let from = phase.active;
  for (const id of phase.nextUp) {
    const r = view.board.find((b) => b.racerId === id);
    if (!r || r.finishedRank !== null || r.eliminated) continue;
    slots.push({ player: r.owner, racers: [r.racerId] });
    listed.add(r.owner);
    from = r.owner;
  }
  const n = view.seatOrder.length;
  const start = view.seatOrder.indexOf(from);
  for (let i = 1; i <= n; i++) {
    const pid = view.seatOrder[(start + i) % n];
    if (pid === undefined || listed.has(pid)) continue;
    const racers = running(pid);
    if (racers.length === 0) continue;
    slots.push({ player: pid, racers });
    listed.add(pid);
  }
  return slots;
}

export function listNames(view: PlayerView, pids: readonly PlayerId[]): string {
  const names = pids.map((p) => playerName(view, p));
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export interface LogLine {
  readonly text: string;
  /** `divider` heads a turn's lines; see `useEventLog`. */
  readonly tone: 'plain' | 'good' | 'bad' | 'power' | 'turn' | 'divider';
}

/**
 * Turns an engine event into a line for the race log, or null for events too noisy to list.
 *
 * `racer/moved` is always null: it fires once per space travelled and the board already
 * shows it. The log is for things a player would otherwise miss — passes, trips, powers.
 */
export function describeEvent(e: GameEvent, view: PlayerView): LogLine | null {
  const who = (pid: PlayerId): string => playerName(view, pid);
  const racer = (id: RacerId): string => racerName(view, id);

  switch (e.t) {
    case 'player/joined':
      return { text: `${who(e.player)} joined`, tone: 'plain' };
    case 'player/left':
      return { text: `${who(e.player)} ${e.kicked ? 'was removed by the host' : 'left'}`, tone: 'plain' };
    case 'game/rematch':
      return { text: `${who(e.by)} started a rematch`, tone: 'turn' };
    case 'lobby/setsChanged':
      return { text: `Racer sets: ${setNames(e.sets)}`, tone: 'plain' };
    case 'game/started':
      return { text: 'The game has started', tone: 'turn' };
    case 'draft/orderSet': {
      const rolls = e.order.map((p) => `${who(p)} ${e.rolls[p]}`).join(', ');
      return { text: `Draft order rolled (${rolls}) — ${who(e.order[0] as PlayerId)} drafts first`, tone: 'turn' };
    }
    case 'draft/picked':
      return { text: `${who(e.player)} drafted ${racer(e.racerId)}`, tone: 'plain' };
    case 'race/started':
      return { text: `Race ${e.raceNo} begins on the ${trackLabel(e.raceNo)}`, tone: 'turn' };
    case 'race/revealed': {
      // Grouped by player, since the two-player variant reveals two racers each.
      const byPlayer = new Map<PlayerId, string[]>();
      for (const p of e.picks) byPlayer.set(p.player, [...(byPlayer.get(p.player) ?? []), racer(p.racerId)]);
      return {
        text: [...byPlayer].map(([p, names]) => `${who(p)}: ${names.join(' + ')}`).join(' · '),
        tone: 'plain',
      };
    }
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
    // The throw itself is the board's business; the log reports the move it settles into.
    case 'dice/thrown':
      return null;
    case 'dice/rolled':
      return {
        text: e.value < 0 ? `${racer(e.racerId)} moves ${-e.value} back` : `${racer(e.racerId)} moves ${e.value}`,
        tone: 'plain',
      };
    case 'racer/passed':
      return { text: `${racer(e.racerId)} passes ${racer(e.passed)}`, tone: 'plain' };
    case 'racer/warped':
      return { text: `${racer(e.racerId)} warps to space ${e.to}`, tone: 'power' };
    case 'racer/tripped':
      return { text: `${racer(e.racerId)} trips!`, tone: 'bad' };
    case 'racer/stoodUp':
      return { text: `${racer(e.racerId)} gets back up instead of moving`, tone: 'plain' };
    case 'space/cleared':
      return { text: `${racer(e.racerId)} sets off the mine on space ${e.pos}`, tone: 'bad' };
    case 'space/mined':
    case 'space/claimed':
      // Already told: Techies' power logs the mine, and the token awarded logs the star.
      return null;
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
    case 'squad/withdrawn':
      return { text: `The rest of ${racer(e.squad)} leaves the track`, tone: 'plain' };
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
