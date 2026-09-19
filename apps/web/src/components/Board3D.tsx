import { FINISH, trackForRace, type PlayerView, type RacerId, type RaceNumber } from '@mr/engine';
import { Billboard, Text } from '@react-three/drei';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { Suspense, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { hasSprite, ordinal, racerInitials, racerName, racerSprite, rawName, seatColor, SEAT_INK } from '../lib/present';
import { ROLL_TUMBLE_MS, type ShownRoll } from '../lib/useBoardPositions';

/**
 * The race track, rendered as a physical tabletop board in 3D.
 *
 * The space layout is identical to the flat board this replaced — a 15 × 4 loop on
 * desktop, transposed to run down one side and back up the other on a phone — just
 * projected onto the ground plane (`x`/`z`) instead of drawn as SVG (`x`/`y`). Space 0 is
 * Start, which the rules count as a real space; the finish sits just past space 29, where
 * the loop closes.
 */

const COLS = 15;
const ROWS = 4;
const GAP = 6;
const PAD = 14;
const R_FINISH = 24;
/** Converts the old pixel-based layout into comfortable Three.js world units. */
const SCALE = 0.024;
/** How thick a track space sits above the table. */
const SPACE_H = 0.3;
const DIE_SIZE = 1.4;

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

function splitLabel(b: Rect, side: 'top' | 'left', size: number): { label: { x: number; y: number }; tokens: Rect } {
  return side === 'top'
    ? { label: { x: b.x + b.w / 2, y: b.y + size / 2 }, tokens: { ...b, y: b.y + size, h: b.h - size } }
    : { label: { x: b.x + size / 2, y: b.y + b.h / 2 }, tokens: { ...b, x: b.x + size, w: b.w - size } };
}

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

function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches);
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const subscribe = (onChange: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  };
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
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

/** Renders the whole scene at a fraction of native resolution, then CSS-upscales with
 * nearest-neighbour so the 3D board reads as chunky pixel art rather than smooth 3D. */
const PIXEL_DPR = 0.42;
/** Steps in the toon gradient: fewer bands = flatter, more retro-cel lighting. */
const TOON_STEPS = 4;

function toonGradient(steps: number): THREE.DataTexture {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) data[i] = Math.round((i / Math.max(1, steps - 1)) * 255);
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function pipTexture(value: number, pip: string, face: string): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = face;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = pip;
    const unit = size / 3.2;
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.1;
    for (const [px, py] of PIPS[value] ?? []) {
      ctx.beginPath();
      ctx.arc(cx + px * unit, cy + py * unit, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function initialsTexture(text: string, ink: string, bg: string): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(size * 0.42)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function checkerTexture(a: string, b: string): THREE.CanvasTexture {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = a;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = b;
    ctx.fillRect(0, 0, size / 2, size / 2);
    ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 2);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Rotates a resting die so the given face value ends up on top (+y), opposite faces sum to 7. */
const FACE_QUATS: Readonly<Record<number, THREE.Quaternion>> = {
  1: new THREE.Quaternion(),
  2: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
  3: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
  4: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2),
  5: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
  6: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
};

interface BoardProps {
  readonly view: PlayerView;
  readonly raceNo: RaceNumber;
  readonly positions: Readonly<Record<string, number>>;
  readonly highlight?: readonly RacerId[];
  readonly claimedSpaces?: readonly number[];
  readonly roll?: ShownRoll | null;
  readonly activeRacer?: RacerId | null;
}

interface PieceTarget {
  readonly racerId: RacerId;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly rank: number | null;
}

/** A camera fixed above the table, angled down — no orbiting, so the board always reads the same way. */
function CameraRig({ portrait }: { portrait: boolean }) {
  const { camera } = useThree();
  useEffect(() => {
    if (portrait) {
      camera.position.set(0, 22, 9);
    } else {
      camera.position.set(0, 24, 15);
    }
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, portrait]);
  return null;
}

function Piece({
  target,
  radius,
  color,
  mine,
  targeted,
  active,
  tripped,
  rank,
  spriteUrl,
  hasArt,
  initials,
  label,
}: {
  target: readonly [number, number];
  radius: number;
  color: string;
  mine: boolean;
  targeted: boolean;
  active: boolean;
  tripped: boolean;
  rank: number | null;
  spriteUrl: string;
  hasArt: boolean;
  initials: string;
  label: string;
}) {
  const group = useRef<THREE.Group>(null);
  const drawn = useRef(new THREE.Vector3(target[0], 0, target[1]));
  const targetVec = useRef(new THREE.Vector3());
  const sprite = hasArt ? useLoader(THREE.TextureLoader, spriteUrl) : null;
  const fallback = useMemo(() => (hasArt ? null : initialsTexture(initials, SEAT_INK, color)), [hasArt, initials, color]);
  const map = sprite ?? fallback ?? null;
  const gradientMap = useMemo(() => toonGradient(TOON_STEPS), []);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    targetVec.current.set(target[0], 0, target[1]);
    const dist = drawn.current.distanceTo(targetVec.current);
    drawn.current.lerp(targetVec.current, Math.min(1, delta * 7));
    // A quick hop while a piece is sliding toward its new space — settles as it arrives.
    const hop = dist > 0.02 ? Math.min(0.45, dist) * Math.abs(Math.sin(performance.now() / 95)) : 0;
    const bob = active ? Math.sin(performance.now() / 260) * 0.06 : 0;
    g.position.set(drawn.current.x, bob + hop, drawn.current.z);
  });

  const h = Math.max(0.22, radius * 0.62);

  return (
    <group ref={group} aria-label={label}>
      {targeted && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
          <ringGeometry args={[radius * 1.08, radius * 1.3, 40]} />
          <meshBasicMaterial color="#ffd23c" transparent opacity={0.85} depthWrite={false} />
        </mesh>
      )}
      {active && <pointLight color={color} intensity={2.4} distance={radius * 7} position={[0, radius * 1.6, 0]} />}
      <mesh position={[0, h / 2 + 0.02, 0]} castShadow>
        <cylinderGeometry args={[radius, radius * 0.98, h, 28]} />
        <meshToonMaterial attach="material-0" color={color} emissive={color} emissiveIntensity={active ? 0.55 : 0.14} gradientMap={gradientMap} />
        <meshToonMaterial attach="material-1" map={map} color={map ? '#ffffff' : color} gradientMap={gradientMap} />
        <meshToonMaterial attach="material-2" color={color} gradientMap={gradientMap} />
      </mesh>
      {mine && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[radius * 0.98, radius * 1.06, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.55} depthWrite={false} />
        </mesh>
      )}
      {tripped && (
        <Billboard position={[radius * 0.75, h + radius * 0.7, 0]}>
          <Text fontSize={Math.max(0.3, radius * 0.55)} color="#ff5b6e" anchorX="center" anchorY="middle" outlineWidth={0.015} outlineColor="#1a1523">
            zZ
          </Text>
        </Billboard>
      )}
      {rank !== null && (
        <Billboard position={[0, h + radius * 0.95, 0]}>
          <Text fontSize={Math.max(0.32, radius * 0.6)} color={color} anchorX="center" anchorY="middle" outlineWidth={0.015} outlineColor="#1a1523">
            {ordinal(rank)}
          </Text>
        </Billboard>
      )}
    </group>
  );
}

function Die({ roll, restX, restZ, reducedMotion, color }: {
  roll: ShownRoll;
  restX: number;
  restZ: number;
  reducedMotion: boolean;
  color: string;
}) {
  const ref = useRef<RapierRigidBody>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const landedAt = useRef(0);
  const rest = useMemo(() => ({ x: restX, y: DIE_SIZE / 2 + 0.02, z: restZ }), [restX, restZ]);
  const gradientMap = useMemo(() => toonGradient(TOON_STEPS), []);
  const materials = useMemo(() => {
    const tex: Record<number, THREE.CanvasTexture> = {};
    for (let v = 1; v <= 6; v++) tex[v] = pipTexture(v, '#26212f', '#f7f3ec');
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z. Opposite faces sum to 7.
    return [tex[3], tex[4], tex[1], tex[6], tex[2], tex[5]];
  }, []);

  useEffect(() => {
    const body = ref.current;
    if (!body) return;
    if (roll.instant || reducedMotion) {
      body.setTranslation(rest, true);
      body.setRotation(FACE_QUATS[roll.face] ?? FACE_QUATS[1]!, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      landedAt.current = performance.now();
      return;
    }
    const spin = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2),
    );
    body.setTranslation({ x: rest.x + (Math.random() - 0.5) * 0.6, y: rest.y + 3.2, z: rest.z + (Math.random() - 0.5) * 0.6 }, true);
    body.setRotation(spin, true);
    body.setLinvel({ x: (Math.random() - 0.5) * 2.4, y: 1.2, z: (Math.random() - 0.5) * 2.4 }, true);
    body.setAngvel({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 20 }, true);
    const timer = setTimeout(() => {
      const b = ref.current;
      if (!b) return;
      b.setTranslation(rest, true);
      b.setRotation(FACE_QUATS[roll.face] ?? FACE_QUATS[1]!, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      landedAt.current = performance.now();
    }, ROLL_TUMBLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the throw, re-run only on a fresh roll
  }, [roll.key, roll.instant, roll.face, reducedMotion]);

  // A brief squash-and-pop on landing gives the die some arcade weight.
  useFrame(() => {
    const m = meshRef.current;
    if (!m) return;
    const t = Math.min(1, (performance.now() - landedAt.current) / 220);
    if (t >= 1) {
      m.scale.set(1, 1, 1);
      return;
    }
    const squash = 1 - Math.sin(t * Math.PI) * 0.22 * (1 - t);
    m.scale.set(1 + (1 - squash) * 0.5, squash, 1 + (1 - squash) * 0.5);
  });

  return (
    <RigidBody ref={ref} colliders="cuboid" restitution={0.25} friction={0.7} position={[rest.x, rest.y, rest.z]}>
      <mesh ref={meshRef} castShadow>
        <boxGeometry args={[DIE_SIZE, DIE_SIZE, DIE_SIZE]} />
        {materials.map((tex, i) => (
          <meshToonMaterial key={i} attach={`material-${i}`} map={tex ?? null} gradientMap={gradientMap} />
        ))}
      </mesh>
      <pointLight color={color} intensity={1.4} distance={4} position={[0, 1.4, 0]} />
    </RigidBody>
  );
}

export function Board3D({
  view,
  raceNo,
  positions,
  highlight = [],
  claimedSpaces = [],
  roll = null,
  activeRacer = null,
}: BoardProps) {
  const wide = useWide();
  const reducedMotion = usePrefersReducedMotion();
  const track = trackForRace(raceNo);
  const tileGradient = useMemo(() => toonGradient(TOON_STEPS), []);
  const g = geometry(!wide);
  const boxes = track.spaces.map((s) => g.rect(gridCell(s.index)));
  const finishBox = g.rect(FINISH_CELL);
  const infield = g.rect(INFIELD_CELL);

  const toWorld = (p: { x: number; y: number }): [number, number] => [(p.x - g.width / 2) * SCALE, (p.y - g.height / 2) * SCALE];

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

  const heading = (index: number): number => {
    const from = boxes[Math.min(index, boxes.length - 2)];
    const to = boxes[Math.min(index + 1, boxes.length - 1)];
    if (!from || !to) return 0;
    const a = center(from);
    const b = center(to);
    return Math.atan2(b.y - a.y, b.x - a.x);
  };

  const startSplit = g.portrait ? splitLabel(boxes[0] ?? finishBox, 'top', 40) : splitLabel(boxes[0] ?? finishBox, 'left', 130);
  const finishSplit = g.portrait ? splitLabel(finishBox, 'left', 78) : splitLabel(finishBox, 'top', 28);
  const inf = center(infield);

  const targets: PieceTarget[] = live.map((r) => {
    const pos = drawnPos(r.racerId, r.pos);
    let x2: number;
    let y2: number;
    let radius: number;
    let rank: number | null = null;

    if (pos >= FINISH) {
      const n = Math.max(0, finished.findIndex((f) => f.racerId === r.racerId));
      rank = r.finishedRank ?? null;
      const area = finishSplit.tokens;
      const s = slot(n, finished.length, area.w - 8, area.h - 8, R_FINISH);
      const c = center(area);
      x2 = c.x + s.dx;
      y2 = c.y + s.dy;
      radius = s.r;
    } else {
      const group = groups.get(pos) ?? [r.racerId];
      const b = boxes[pos] ?? boxes[0] ?? { x: 0, y: 0, w: 0, h: 0 };
      const area = pos === 0 ? startSplit.tokens : b;
      const c = center(area);
      const s = slot(group.indexOf(r.racerId), group.length, area.w - 6, area.h - 6, 30);
      x2 = c.x + s.dx;
      y2 = c.y + s.dy;
      radius = s.r;
    }
    const [x, z] = toWorld({ x: x2, y: y2 });
    return { racerId: r.racerId, x, z, radius: radius * SCALE, rank };
  });

  const [dieRestX, dieRestZ] = toWorld(g.portrait ? { x: inf.x, y: inf.y - 40 } : { x: inf.x - 90, y: inf.y });
  const rollOwner = roll ? view.board.find((b) => b.racerId === roll.racerId)?.owner : undefined;
  const rollColor = rollOwner ? seatColor(view, rollOwner) : '#ffc93c';

  const summary = live
    .map((r) => {
      const pos = drawnPos(r.racerId, r.pos);
      const where = pos >= FINISH ? `finished ${ordinal(r.finishedRank ?? 0)}` : `space ${pos}`;
      return `${racerName(view, r.racerId)} (${rawName(view, r.owner)}): ${where}${r.tripped ? ', tripped' : ''}`;
    })
    .join('. ');

  return (
    <div className="board3d-wrap" role="img" aria-label={`${track.name} race track`}>
      <Canvas shadows dpr={[PIXEL_DPR, PIXEL_DPR]} camera={{ fov: 42 }} gl={{ antialias: false }}>
        <CameraRig portrait={g.portrait} />
        <color attach="background" args={['#100c1c']} />
        <fog attach="fog" args={['#100c1c', 22, 46]} />
        <ambientLight intensity={0.4} />
        <hemisphereLight args={['#ffd9a0', '#1a0f2e', 0.4]} />
        <directionalLight position={[8, 16, 6]} intensity={1.6} color="#fff4d6" castShadow shadow-mapSize={[512, 512]} />
        <directionalLight position={[-10, 9, -8]} intensity={0.45} color="#5ea8ef" />

        <Physics gravity={[0, -22, 0]}>
          <RigidBody type="fixed" colliders="cuboid">
            <mesh position={[0, -0.05, 0]} receiveShadow>
              <boxGeometry args={[g.width * SCALE + 2, 0.1, g.height * SCALE + 2]} />
              <meshToonMaterial color="#1c1630" gradientMap={tileGradient} />
            </mesh>
          </RigidBody>

          {track.spaces.map((space, i) => {
            const b = boxes[i] ?? { x: 0, y: 0, w: 0, h: 0 };
            const c = center(b);
            const [x, z] = toWorld(c);
            const e = space.effect;
            const isStart = space.index === 0;
            const claimed = e.t === 'star' && claimedSpaces.includes(space.index);
            const fill = isStart
              ? SPACE_COLORS[3]
              : (SPACE_COLORS[(space.index - 1) % SPACE_COLORS.length] ?? SPACE_COLORS[0]);
            const w = b.w * SCALE;
            const d = b.h * SCALE;
            const glyphY = SPACE_H + 0.02;

            return (
              <group key={space.index}>
                <mesh position={[x, SPACE_H / 2, z]} receiveShadow>
                  <boxGeometry args={[w * 0.94, SPACE_H, d * 0.94]} />
                  <meshToonMaterial color={fill} emissive={claimed ? '#ffd23c' : '#000000'} emissiveIntensity={claimed ? 0.35 : 0} gradientMap={tileGradient} />
                </mesh>
                {isStart && (
                  <Text position={[x, glyphY, z]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.7} color="#1a1523" anchorX="center" anchorY="middle">
                    START
                  </Text>
                )}
                {!isStart && e.t === 'plain' && space.index % 5 === 0 && (
                  <Text position={[x, glyphY, z]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.85} color="#1a1523" anchorX="center" anchorY="middle">
                    {space.index}
                  </Text>
                )}
                {!isStart && !(e.t === 'plain' && space.index % 5 === 0) && (
                  <Text
                    position={[x - w * 0.3, glyphY, z - d * 0.3]}
                    rotation={[-Math.PI / 2, 0, 0]}
                    fontSize={0.36}
                    color="#1a1523"
                    anchorX="center"
                    anchorY="middle"
                  >
                    {space.index}
                  </Text>
                )}
                {e.t === 'star' && (
                  <Text position={[x, glyphY, z]} rotation={[-Math.PI / 2, 0, 0]} fontSize={1.1} color="#fff4d6" anchorX="center" anchorY="middle">
                    ★
                  </Text>
                )}
                {e.t === 'trip' && (
                  <Text position={[x, glyphY, z]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.42} color="#1a1523" anchorX="center" anchorY="middle">
                    TRIP!
                  </Text>
                )}
                {e.t === 'arrow' && (
                  <Text
                    position={[x, glyphY, z]}
                    rotation={[-Math.PI / 2, 0, heading(space.index) + (e.amount < 0 ? Math.PI : 0)]}
                    fontSize={0.7}
                    color="#1a1523"
                    anchorX="center"
                    anchorY="middle"
                  >
                    {`→${Math.abs(e.amount)}`}
                  </Text>
                )}
              </group>
            );
          })}

          {(() => {
            const c = center(infield);
            const [x, z] = toWorld(c);
            const w = infield.w * SCALE;
            const d = infield.h * SCALE;
            return (
              <group>
                <mesh position={[x, -0.005, z]} receiveShadow>
                  <boxGeometry args={[w, 0.02, d]} />
                  <meshToonMaterial color="#241d3a" gradientMap={tileGradient} />
                </mesh>
                <Text
                  position={[x, 0.02, z]}
                  rotation={[-Math.PI / 2, 0, g.portrait ? Math.PI / 2 : 0]}
                  fontSize={g.portrait ? 0.6 : 1}
                  color="#7a6ea8"
                  anchorX="center"
                  anchorY="middle"
                >
                  {track.name.toUpperCase()}
                </Text>
              </group>
            );
          })()}

          {(() => {
            const c = center(finishBox);
            const [x, z] = toWorld(c);
            const w = finishBox.w * SCALE;
            const d = finishBox.h * SCALE;
            const checker = useMemo(() => checkerTexture('#f7f3ec', '#1a1523'), []);
            return (
              <group>
                <mesh position={[x, SPACE_H / 2, z]} receiveShadow>
                  <boxGeometry args={[w * 0.94, SPACE_H, d * 0.94]} />
                  <meshToonMaterial attach="material-0" color="#1a1523" gradientMap={tileGradient} />
                  <meshToonMaterial attach="material-1" color="#1a1523" gradientMap={tileGradient} />
                  <meshToonMaterial attach="material-2" map={checker} gradientMap={tileGradient} />
                  <meshToonMaterial attach="material-3" color="#1a1523" gradientMap={tileGradient} />
                  <meshToonMaterial attach="material-4" color="#1a1523" gradientMap={tileGradient} />
                  <meshToonMaterial attach="material-5" color="#1a1523" gradientMap={tileGradient} />
                </mesh>
                <Text position={[finishSplit.label ? x : x, SPACE_H + 0.05, z]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.55} color="#fff4d6" anchorX="center" anchorY="middle">
                  FINISH
                </Text>
              </group>
            );
          })()}

          {roll && <Die key={roll.key} roll={roll} restX={dieRestX} restZ={dieRestZ} reducedMotion={reducedMotion} color={rollColor} />}

          <Suspense fallback={null}>
            {live.map((r) => {
              const t = targets.find((x) => x.racerId === r.racerId);
              if (!t) return null;
              const label = `${racerName(view, r.racerId)} (${rawName(view, r.owner)})${r.tripped ? ', tripped' : ''}${
                t.rank ? `, finished ${ordinal(t.rank)}` : `, space ${drawnPos(r.racerId, r.pos)}`
              }`;
              return (
                <Piece
                  key={r.racerId}
                  target={[t.x, t.z]}
                  radius={Math.max(0.32, t.radius)}
                  color={seatColor(view, r.owner)}
                  mine={r.owner === view.you}
                  targeted={highlight.includes(r.racerId)}
                  active={r.racerId === activeRacer && t.rank === null}
                  tripped={r.tripped}
                  rank={t.rank}
                  spriteUrl={racerSprite(r.racerId)}
                  hasArt={hasSprite(r.racerId)}
                  initials={racerInitials(r.racerId)}
                  label={label}
                />
              );
            })}
          </Suspense>
        </Physics>
      </Canvas>

      {roll && (
        <div className="board3d-callout" style={{ borderColor: rollColor }}>
          <span className="board3d-callout-name" style={{ color: rollColor }}>
            {racerName(view, roll.racerId)}
          </span>
          <span className="board3d-callout-roll">
            rolled {roll.face}
            {roll.modifiedBy ? ` (${racerName(view, roll.modifiedBy)})` : ''}
          </span>
          {roll.move !== null && (roll.move ?? roll.face) !== roll.face && (
            <span className="board3d-callout-maths num">
              {roll.replaced
                ? roll.move === 0
                  ? 'no move'
                  : `moves ${roll.move} instead`
                : `${roll.face} ${roll.move! < roll.face ? '−' : '+'} ${Math.abs(roll.move! - roll.face)} = ${roll.move}`}
            </span>
          )}
        </div>
      )}

      <p className="visually-hidden" aria-live="polite">
        {summary}
      </p>
    </div>
  );
}
