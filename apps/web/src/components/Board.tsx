import { FINISH, trackForRace, type PlayerView, type RacerId, type RaceNumber } from '@mr/engine';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasSprite, ordinal, racerInitials, racerName, racerSprite, rawName, seatColor } from '../lib/present';
import { ROLL_TUMBLE_MS, type ShownRoll } from '../lib/useBoardPositions';

/**
 * The race track, drawn as a loop like the physical board.
 *
 * Laid out on a 15 × 4 grid (landscape):
 *
 *   START·· 1  2  3  4  5  6  7  8  9 10 11 12
 *   FIN     ┌───────── infield ─────────┐   13
 *   FIN     └───────────────────────────┘   14
 *   29 28 27 26 25 24 23 22 21 20 19 18 17 16 15
 *
 * Space 0 is the Start space, which the rules count as a real space. The finish sits just
 * past space 29, where the loop closes. On a phone the same grid is transposed, so the
 * track runs down the left side and back up the right.
 */

const COLS = 15;
const ROWS = 4;
const GAP = 6;
/** The dark rim around the track. */
const PAD = 14;
const R_FINISH = 24;
/**
 * How much of a piece's diameter its portrait fills.
 *
 * Small enough that the art sits inside the disc rather than on it, so a ring of the
 * owner's seat colour always shows — art that is opaque rather than cut out would
 * otherwise swallow the one cue for whose racer this is.
 */
const SPRITE_INSET = 0.84;

/** Plain spaces cycle through the board's colours, like the printed track. */
const SPACE_COLORS = ['#f28fd0', '#ffc93c', '#44bf6c', '#5ea8ef', '#f0473c'] as const;

interface Cell {
  readonly c: number;
  readonly r: number;
  readonly cs: number;
  readonly rs: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where a space sits on the landscape grid. */
function gridCell(index: number): Cell {
  if (index === 0) return { c: 0, r: 0, cs: 3, rs: 1 };
  if (index <= 12) return { c: index + 2, r: 0, cs: 1, rs: 1 };
  if (index <= 14) return { c: COLS - 1, r: index - 12, cs: 1, rs: 1 };
  return { c: 29 - index, r: ROWS - 1, cs: 1, rs: 1 };
}

const FINISH_CELL: Cell = { c: 0, r: 1, cs: 1, rs: 2 };
const INFIELD_CELL: Cell = { c: 1, r: 1, cs: COLS - 2, rs: 2 };

interface Geometry {
  readonly portrait: boolean;
  readonly width: number;
  readonly height: number;
  rect(cell: Cell): Rect;
}

function geometry(portrait: boolean): Geometry {
  // Portrait cells are short and wide so thirty spaces fit a phone without endless scrolling.
  const colW = 100;
  const rowH = portrait ? 54 : 100;
  const across = portrait ? ROWS : COLS;
  const down = portrait ? COLS : ROWS;
  return {
    portrait,
    width: PAD * 2 + across * colW + (across - 1) * GAP,
    height: PAD * 2 + down * rowH + (down - 1) * GAP,
    rect(cell) {
      const c = portrait ? cell.r : cell.c;
      const r = portrait ? cell.c : cell.r;
      const cs = portrait ? cell.rs : cell.cs;
      const rs = portrait ? cell.cs : cell.rs;
      return {
        x: PAD + c * (colW + GAP),
        y: PAD + r * (rowH + GAP),
        w: cs * colW + (cs - 1) * GAP,
        h: rs * rowH + (rs - 1) * GAP,
      };
    },
  };
}

const center = (b: Rect) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Splits a strip off a box for a label, so racers standing there never cover it. */
function splitLabel(b: Rect, side: 'top' | 'left', size: number): { label: { x: number; y: number }; tokens: Rect } {
  return side === 'top'
    ? { label: { x: b.x + b.w / 2, y: b.y + size / 2 }, tokens: { ...b, y: b.y + size, h: b.h - size } }
    : { label: { x: b.x + size / 2, y: b.y + b.h / 2 }, tokens: { ...b, x: b.x + size, w: b.w - size } };
}

/**
 * Where to put the n-th of `count` tokens in a box, and how big to draw them: whichever
 * row/column split gives the largest tokens.
 */
function slot(n: number, count: number, w: number, h: number, max: number): { dx: number; dy: number; r: number } {
  let best = { perRow: 1, r: 0 };
  for (let perRow = 1; perRow <= Math.max(1, count); perRow++) {
    const rows = Math.ceil(count / perRow);
    const r = Math.min(max, (Math.min(w / perRow, h / rows) / 2) * 0.88);
    if (r > best.r) best = { perRow, r };
  }
  const rows = Math.ceil(count / best.perRow);
  const col = n % best.perRow;
  const row = Math.floor(n / best.perRow);
  const inRow = row === rows - 1 ? count - row * best.perRow : best.perRow;
  const stepX = w / best.perRow;
  const stepY = h / rows;
  return {
    dx: (col - (inRow - 1) / 2) * stepX,
    dy: (row - (rows - 1) / 2) * stepY,
    r: best.r,
  };
}

const WIDE_QUERY = '(min-width: 960px)';

function subscribeWide(onChange: () => void): () => void {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** Landscape once the race screen is wide enough to give the board its own full-width row. */
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches);
}

/** Pip positions on a die face, in units of a third of the face. */
const PIPS: Record<number, readonly (readonly [number, number])[]> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

/**
 * The latest roll as a big die in the infield. It tumbles through random faces, lands on
 * the face that was thrown, and then names who threw it. Remounted per throw via `key`.
 *
 * The pips are always the real face. What a power did to it is spelled out underneath: an
 * adjustment as arithmetic ("4 + 3 = 7", Blimp), a substitution as a swap ("4 instead",
 * Alchemist), because a 1 traded for a move of 4 was never "1 + 3". While `roll.move` is
 * still null the die simply sits there — powers are mid-decision, and the player is being
 * asked about the very face they can see.
 */
function Die({ view, roll, x, y, size, color, portrait }: {
  view: PlayerView;
  roll: ShownRoll;
  x: number;
  y: number;
  size: number;
  color: string;
  portrait: boolean;
}) {
  const [face, setFace] = useState(() => (roll.instant ? roll.face : 1 + Math.floor(Math.random() * 6)));
  const [landed, setLanded] = useState(roll.instant);

  // Keyed by the throw, so settling the move into an already-landed die does not set it
  // tumbling again — only a fresh throw does that.
  useEffect(() => {
    if (roll.instant) return;
    const spin = setInterval(() => setFace((f) => ((f + 1 + Math.floor(Math.random() * 4)) % 6) + 1), 75);
    const land = setTimeout(() => {
      clearInterval(spin);
      setFace(roll.face);
      setLanded(true);
    }, ROLL_TUMBLE_MS);
    return () => {
      clearInterval(spin);
      clearTimeout(land);
    };
  }, [roll.key, roll.instant, roll.face]);

  const pips = PIPS[face];
  const unit = size / 3.4;
  const name = racerName(view, roll.racerId);
  const by = roll.modifiedBy ? ` (${racerName(view, roll.modifiedBy)})` : '';
  const delta = (roll.move ?? roll.face) - roll.face;
  // U+2212 for the minus, so "4 − 1 = 3" lines up with the digits either side of it.
  const maths =
    roll.move === null || delta === 0
      ? null
      : roll.replaced
        ? roll.move === 0
          ? `no move${by}`
          : `moves ${roll.move} instead${by}`
        : `${roll.face} ${delta < 0 ? '−' : '+'} ${Math.abs(delta)} = ${roll.move}${by}`;
  const labelX = portrait ? x : x + size / 2 + 22;
  const labelY = portrait ? y + size / 2 + 30 : y - (maths ? 15 : 0);

  return (
    <g className={`dice${landed ? ' dice-landed' : ' dice-tumbling'}`}>
      <title>{`${name} rolled ${roll.face}${maths ? `, moves ${roll.move}` : ''}`}</title>
      <g transform={`translate(${x} ${y})`}>
        <g className="dice-body">
          <rect x={-size / 2} y={-size / 2} width={size} height={size} rx={size * 0.2} className="dice-face" style={{ stroke: color }} />
          {pips ? (
            pips.map(([px, py], i) => <circle key={i} cx={px * unit} cy={py * unit} r={size * 0.085} className="dice-pip" />)
          ) : (
            <text className="dice-number num">{face}</text>
          )}
        </g>
      </g>
      {landed && (
        <text className="dice-label" x={labelX} y={labelY} style={{ textAnchor: portrait ? 'middle' : 'start' }}>
          <tspan x={labelX} dy={portrait ? 0 : '-0.55em'} style={{ fill: color }}>
            {name}
          </tspan>
          <tspan x={labelX} dy="1.2em">
            {maths ? `rolled ${roll.face}` : `rolled ${roll.face}${by}`}
          </tspan>
          {maths && (
            <tspan className="dice-maths num" x={labelX} dy="1.25em">
              {maths}
            </tspan>
          )}
        </text>
      )}
    </g>
  );
}

interface BoardProps {
  readonly view: PlayerView;
  readonly raceNo: RaceNumber;
  /** Drawn positions, which lag the true board while moves animate. */
  readonly positions: Readonly<Record<string, number>>;
  /** Racers to highlight, e.g. the target of a decision. */
  readonly highlight?: readonly RacerId[];
  readonly claimedSpaces?: readonly number[];
  /** The latest roll, drawn as a die in the infield. */
  readonly roll?: ShownRoll | null;
  /** The racer whose turn it is, which gets a glow. */
  readonly activeRacer?: RacerId | null;
}

export function Board({
  view,
  raceNo,
  positions,
  highlight = [],
  claimedSpaces = [],
  roll = null,
  activeRacer = null,
}: BoardProps) {
  const track = trackForRace(raceNo);
  const g = geometry(!useWide());
  const boxes = track.spaces.map((s) => g.rect(gridCell(s.index)));
  const finishBox = g.rect(FINISH_CELL);
  const infield = g.rect(INFIELD_CELL);

  // Group racers by where they are drawn, so racers sharing a space fan out.
  const live = view.board.filter((r) => !r.eliminated);
  const drawnPos = (id: RacerId, fallback: number): number => positions[id] ?? fallback;
  const groups = new Map<number, RacerId[]>();
  for (const r of live) {
    const pos = drawnPos(r.racerId, r.pos);
    const list = groups.get(pos) ?? [];
    list.push(r.racerId);
    groups.set(pos, list);
  }

  const finished = live
    .filter((r) => drawnPos(r.racerId, r.pos) >= FINISH)
    .sort((a, b) => (a.finishedRank ?? 99) - (b.finishedRank ?? 99));

  /** Direction of travel at a space, in degrees, for drawing arrows. */
  const heading = (index: number): number => {
    const from = boxes[Math.min(index, boxes.length - 2)];
    const to = boxes[Math.min(index + 1, boxes.length - 1)];
    if (!from || !to) return 0;
    const a = center(from);
    const b = center(to);
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  };

  const inf = center(infield);
  const startSplit = g.portrait ? splitLabel(boxes[0] ?? finishBox, 'top', 40) : splitLabel(boxes[0] ?? finishBox, 'left', 130);
  const finishSplit = g.portrait ? splitLabel(finishBox, 'left', 78) : splitLabel(finishBox, 'top', 28);

  return (
    <svg className="board" viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label={`${track.name} race track`}>
      <defs>
        {/* One clip for every portrait: object-bounding-box units make it scale to each
            piece's own square, so pieces of different sizes share the one definition, and
            square art is cropped to the disc instead of overhanging it. */}
        <clipPath id="piece-disc" clipPathUnits="objectBoundingBox">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
        {/* Racing-flag check for the finish pad, at a scale that reads as texture, not tiles. */}
        <pattern id="finish-check" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform={g.portrait ? 'rotate(90)' : undefined}>
          <rect width="16" height="16" className="finish-check-a" />
          <rect width="8" height="8" className="finish-check-b" />
          <rect x="8" y="8" width="8" height="8" className="finish-check-b" />
        </pattern>
      </defs>
      <rect className="board-rim" x={0} y={0} width={g.width} height={g.height} rx={PAD + 26} />
      <rect
        className="board-outline"
        x={PAD / 2}
        y={PAD / 2}
        width={g.width - PAD}
        height={g.height - PAD}
        rx={PAD + 20}
      />
      <rect
        className="board-outline"
        x={infield.x - GAP / 2}
        y={infield.y - GAP / 2}
        width={infield.w + GAP}
        height={infield.h + GAP}
        rx={10}
      />
      <text
        className={`infield-name${roll ? ' infield-name-dim' : ''}`}
        x={inf.x}
        y={inf.y}
        transform={g.portrait ? `rotate(-90 ${inf.x} ${inf.y})` : undefined}
      >
        {track.name.toUpperCase()}
      </text>

      {track.spaces.map((space, i) => {
        const b = boxes[i] ?? { x: 0, y: 0, w: 0, h: 0 };
        const c = center(b);
        const e = space.effect;
        const isStart = space.index === 0;
        const claimed = e.t === 'star' && claimedSpaces.includes(space.index);
        const fill = isStart ? SPACE_COLORS[3] : SPACE_COLORS[(space.index - 1) % SPACE_COLORS.length];
        const inset = 7;

        return (
          <g key={space.index} className={claimed ? 'space-claimed' : undefined}>
            <rect className="space" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} fill={fill} />
            {e.t !== 'plain' && (
              <rect
                className="space-panel"
                x={b.x + inset}
                y={b.y + inset}
                width={b.w - inset * 2}
                height={b.h - inset * 2}
                rx={5}
              />
            )}
            {isStart && (
              <text
                className="start-label"
                x={startSplit.label.x}
                y={startSplit.label.y}
                style={g.portrait ? { fontSize: 24 } : undefined}
              >
                START
              </text>
            )}
            {!isStart && e.t === 'plain' && space.index % 5 === 0 && (
              <text className="milestone num" x={c.x} y={c.y}>
                {space.index}
              </text>
            )}
            {!isStart && !(e.t === 'plain' && space.index % 5 === 0) && (
              <text className="idx num" x={b.x + 6} y={b.y + 15}>
                {space.index}
              </text>
            )}
            {e.t === 'star' && (
              <text className="glyph glyph-star" x={c.x} y={c.y}>
                ★
              </text>
            )}
            {e.t === 'trip' && (
              <text className="glyph glyph-trip" x={c.x} y={c.y}>
                TRIP!
              </text>
            )}
            {e.t === 'arrow' && (
              <g transform={`translate(${c.x} ${c.y})`}>
                <path
                  className="glyph-arrow-shape"
                  d="M-24 -9 H4 V-18 L24 0 L4 18 V9 H-24 Z"
                  transform={`rotate(${heading(space.index) + (e.amount < 0 ? 180 : 0)}) scale(${g.portrait ? 0.85 : 1})`}
                />
                <text className="glyph glyph-arrow num">{Math.abs(e.amount)}</text>
              </g>
            )}
            <title>
              {isStart
                ? 'Start'
                : e.t === 'star'
                  ? `Space ${space.index}: star, 1 point${claimed ? ' (already taken)' : ''}`
                  : e.t === 'trip'
                    ? `Space ${space.index}: trip`
                    : e.t === 'arrow'
                      ? `Space ${space.index}: move ${e.amount > 0 ? 'forward' : 'back'} ${Math.abs(e.amount)}`
                      : `Space ${space.index}`}
            </title>
          </g>
        );
      })}

      <rect className="finish" x={finishBox.x} y={finishBox.y} width={finishBox.w} height={finishBox.h} rx={8} />
      <rect
        className="finish-check"
        x={finishBox.x}
        y={finishBox.y}
        width={finishBox.w}
        height={finishBox.h}
        rx={8}
        fill="url(#finish-check)"
      />
      <text
        className="finish-label"
        x={finishSplit.label.x}
        y={finishSplit.label.y}
      >
        FINISH
      </text>

      {roll && (() => {
        const owner = view.board.find((b) => b.racerId === roll.racerId)?.owner;
        const size = g.portrait ? 96 : 120;
        return (
          <Die
            view={view}
            key={roll.key}
            roll={roll}
            x={g.portrait ? inf.x : inf.x - 90}
            y={g.portrait ? inf.y - 40 : inf.y}
            size={size}
            color={owner ? seatColor(view, owner) : '#ffc93c'}
            portrait={g.portrait}
          />
        );
      })()}

      {live.map((r) => {
        const pos = drawnPos(r.racerId, r.pos);
        let x: number;
        let y: number;
        let radius: number;
        let rank: number | null = null;

        if (pos >= FINISH) {
          const n = Math.max(0, finished.findIndex((f) => f.racerId === r.racerId));
          rank = r.finishedRank;
          const area = finishSplit.tokens;
          const s = slot(n, finished.length, area.w - 8, area.h - 8, R_FINISH);
          x = center(area).x + s.dx;
          y = center(area).y + s.dy;
          radius = s.r;
        } else {
          const group = groups.get(pos) ?? [r.racerId];
          const b = boxes[pos] ?? boxes[0] ?? { x: 0, y: 0, w: 0, h: 0 };
          const area = pos === 0 ? startSplit.tokens : b;
          const c = center(area);
          const s = slot(group.indexOf(r.racerId), group.length, area.w - 6, area.h - 6, 30);
          x = c.x + s.dx;
          y = c.y + s.dy;
          radius = s.r;
        }

        const mine = r.owner === view.you;
        const targeted = highlight.includes(r.racerId);
        const label = `${racerName(view, r.racerId)} (${rawName(view, r.owner)})${
          r.tripped ? ', tripped' : ''
        }${rank ? `, finished ${ordinal(rank)}` : `, space ${pos}`}`;

        return (
          <g
            key={r.racerId}
            className={`piece${r.tripped ? ' piece-tripped' : ''}`}
            style={{ transform: `translate(${x}px, ${y}px)` }}
          >
            <title>{label}</title>
            {targeted && <circle r={radius + 6} fill="none" className="piece-target" />}
            {r.racerId === activeRacer && rank === null && (
              <circle r={radius + 5} className="piece-active" style={{ fill: seatColor(view, r.owner) }} />
            )}
            {/* Keyed by space, so every step remounts it and replays the hop. */}
            <g key={pos} className="piece-hop">
              <circle
                r={radius}
                fill={seatColor(view, r.owner)}
                className={mine ? 'piece-you' : 'piece-ring'}
              />
              {/* Initials, not the stand-in face: every racer without art would wear the
                  same one, and a board of identical faces is worse than no art at all. */}
              {hasSprite(r.racerId) ? (
                <image
                  className="piece-sprite"
                  href={racerSprite(r.racerId)}
                  x={-radius * SPRITE_INSET}
                  y={-radius * SPRITE_INSET}
                  width={radius * 2 * SPRITE_INSET}
                  height={radius * 2 * SPRITE_INSET}
                  preserveAspectRatio="xMidYMid meet"
                  clipPath="url(#piece-disc)"
                />
              ) : (
                <text className="piece-label" style={{ fontSize: Math.round(radius * 0.8) }}>
                  {racerInitials(r.racerId)}
                </text>
              )}
            </g>
            {r.tripped && (
              <g transform={`translate(${radius * 0.72} ${-radius * 0.72})`}>
                <circle r={Math.max(7, radius * 0.38)} className="trip-badge" />
                <text className="trip-badge-label" style={{ fontSize: Math.max(9, Math.round(radius * 0.46)) }}>
                  z
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
