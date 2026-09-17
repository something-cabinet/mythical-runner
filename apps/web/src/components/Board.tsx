import { FINISH, trackForRace, type PlayerView, type RacerId, type RaceNumber } from '@mr/engine';
import { ordinal, racerInitials, racerName, rawName, seatColor } from '../lib/present';

/**
 * The race track, drawn as a snake so thirty spaces fit a phone held upright.
 *
 *   row 0:   0  1  2  3  4  5  →
 *   row 1:  11 10  9  8  7  6  ←
 *   row 2:  12 13 14 15 16 17  →
 *   row 3:  23 22 21 20 19 18  ←
 *   row 4:  24 25 26 27 28 29  →  finish
 *
 * A line runs through the space centres in order, so the direction of travel is readable
 * without numbering every space. Space 0 is the Start space, which the rules count as a
 * real space.
 */

const COLS = 6;
const ROWS = 5;
const CELL = 100;
const GAP = 10;
const PAD = 10;
const FINISH_H = 84;
/** Token radius for a racer alone on a space; shrinks as a space gets crowded. */
const R_FINISH = 26;

const WIDTH = PAD * 2 + COLS * CELL + (COLS - 1) * GAP;
const FINISH_Y = PAD + ROWS * (CELL + GAP);
const HEIGHT = FINISH_Y + FINISH_H + PAD;

function cellOrigin(index: number): { x: number; y: number } {
  const row = Math.floor(index / COLS);
  const offset = index % COLS;
  const col = row % 2 === 0 ? offset : COLS - 1 - offset;
  return { x: PAD + col * (CELL + GAP), y: PAD + row * (CELL + GAP) };
}

function cellCenter(index: number): { x: number; y: number } {
  const { x, y } = cellOrigin(index);
  return { x: x + CELL / 2, y: y + CELL / 2 };
}

/**
 * Where to put the n-th of `count` racers sharing one space, and how big to draw it.
 *
 * The board scales down to roughly 45 px per space on a phone, so a token has to be as
 * large as the crowd allows: one racer gets nearly the whole space, six share it.
 */
function slot(n: number, count: number): { dx: number; dy: number; r: number } {
  if (count <= 1) return { dx: 0, dy: 8, r: 30 };
  if (count === 2) return { dx: n === 0 ? -23 : 23, dy: 8, r: 23 };
  const perRow = count <= 4 ? 2 : 3;
  const step = perRow === 2 ? 44 : 31;
  const col = n % perRow;
  const row = Math.floor(n / perRow);
  const rows = Math.ceil(count / perRow);
  return {
    dx: (col - (perRow - 1) / 2) * step,
    dy: (row - (rows - 1) / 2) * 40 + 10,
    r: perRow === 2 ? 20 : 15,
  };
}

interface BoardProps {
  readonly view: PlayerView;
  readonly raceNo: RaceNumber;
  /** Drawn positions, which lag the true board while moves animate. */
  readonly positions: Readonly<Record<string, number>>;
  /** Racers to highlight, e.g. the target of a decision. */
  readonly highlight?: readonly RacerId[];
  readonly claimedSpaces?: readonly number[];
}

export function Board({ view, raceNo, positions, highlight = [], claimedSpaces = [] }: BoardProps) {
  const track = trackForRace(raceNo);

  const pathPoints = track.spaces.map((s) => cellCenter(s.index));
  const last = pathPoints[pathPoints.length - 1] ?? { x: 0, y: 0 };
  const path = [...pathPoints, { x: last.x, y: FINISH_Y + FINISH_H / 2 }]
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`)
    .join(' ');

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

  return (
    <svg
      className="board"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${track.name} race track`}
    >
      <path className="track-line" d={path} />

      {track.spaces.map((space) => {
        const { x, y } = cellOrigin(space.index);
        const c = cellCenter(space.index);
        const e = space.effect;
        const isStart = space.index === 0;
        const kind = isStart ? 'start' : e.t;
        const claimed = e.t === 'star' && claimedSpaces.includes(space.index);

        return (
          <g key={space.index}>
            <rect
              className={`space space-${kind}${claimed ? ' space-claimed' : ''}`}
              x={x}
              y={y}
              width={CELL}
              height={CELL}
              rx={16}
            />
            {!isStart && (
              <text className="idx num" x={x + 10} y={y + 22}>
                {space.index}
              </text>
            )}
            {isStart && (
              // Top-left like the space numbers, so racers waiting on Start never cover it.
              <text className="idx" x={x + 10} y={y + 22}>
                START
              </text>
            )}
            {e.t === 'star' && (
              <text className={`glyph glyph-star${claimed ? ' space-claimed' : ''}`} x={c.x} y={c.y}>
                ★
              </text>
            )}
            {e.t === 'trip' && (
              <text className="glyph glyph-trip" x={c.x} y={c.y}>
                TRIP
              </text>
            )}
            {e.t === 'arrow' && (
              <text className="glyph glyph-arrow num" x={c.x} y={c.y}>
                {e.amount > 0 ? `+${e.amount}` : `−${-e.amount}`}
              </text>
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

      <rect className="finish" x={PAD} y={FINISH_Y} width={WIDTH - PAD * 2} height={FINISH_H} rx={16} />
      <text className="finish-label" x={PAD + 22} y={FINISH_Y + FINISH_H / 2 + 6}>
        FINISH
      </text>

      {live.map((r) => {
        const pos = drawnPos(r.racerId, r.pos);
        let x: number;
        let y: number;
        let radius: number;
        let rank: number | null = null;

        if (pos >= FINISH) {
          const n = finished.findIndex((f) => f.racerId === r.racerId);
          rank = r.finishedRank;
          x = PAD + 200 + Math.max(0, n) * 70;
          y = FINISH_Y + FINISH_H / 2;
          radius = R_FINISH;
        } else {
          const group = groups.get(pos) ?? [r.racerId];
          const c = cellCenter(pos);
          const s = slot(group.indexOf(r.racerId), group.length);
          x = c.x + s.dx;
          y = c.y + s.dy;
          radius = s.r;
        }

        const mine = r.owner === view.you;
        const targeted = highlight.includes(r.racerId);
        const label = `${racerName(r.racerId)} (${rawName(view, r.owner)})${
          r.tripped ? ', tripped' : ''
        }${rank ? `, finished ${ordinal(rank)}` : `, space ${pos}`}`;

        return (
          <g
            key={r.racerId}
            className={`piece${r.tripped ? ' piece-tripped' : ''}`}
            style={{ transform: `translate(${x}px, ${y}px)` }}
          >
            <title>{label}</title>
            {targeted && <circle r={radius + 7} fill="none" className="piece-target" />}
            <circle
              r={radius}
              fill={seatColor(view, r.owner)}
              className={mine ? 'piece-you' : 'piece-ring'}
            />
            <text className="piece-label" style={{ fontSize: Math.round(radius * 0.8) }}>
              {racerInitials(r.racerId)}
            </text>
            {r.tripped && (
              // A badge on its own background, so it reads in both themes rather than
              // disappearing against the dark board.
              <g transform={`translate(${radius * 0.72} ${-radius * 0.72})`}>
                <circle r={Math.max(8, radius * 0.38)} className="trip-badge" />
                <text className="trip-badge-label" style={{ fontSize: Math.max(10, Math.round(radius * 0.46)) }}>
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
