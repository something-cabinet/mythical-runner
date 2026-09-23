/**
 * A rope drawn between two points on the board — the visual for any power that ties two
 * racers together (Grimstroke's Soulbind, and whatever links come after it).
 *
 * The rope sags under its own weight, more the longer it runs, so a tight pair and a
 * stretched one read differently at a glance. `kind` becomes the class `tether-<kind>`,
 * so a new link can get its own look from the stylesheet alone; the shared `.tether`
 * styles give every kind the same drawn-rope base.
 */
export function Tether({
  from,
  to,
  color,
  kind = 'rope',
  title,
}: {
  from: { readonly x: number; readonly y: number };
  to: { readonly x: number; readonly y: number };
  color: string;
  kind?: string;
  title?: string;
}) {
  const d = tetherPath(from, to);
  return (
    <g className={`tether tether-${kind}`} style={{ color }}>
      {title && <title>{title}</title>}
      <path className="tether-shadow" d={d} />
      <path className="tether-core" d={d} />
      <path className="tether-flow" d={d} />
    </g>
  );
}

/**
 * The rope's curve: a quadratic from `a` to `b` whose middle hangs below the straight line.
 * Two racers on one space still get a small visible loop rather than a zero-length line.
 */
function tetherPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const sag = 14 + Math.min(70, dist * 0.18);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 + sag;
  const r = (n: number): number => Math.round(n * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} Q ${r(mx)} ${r(my)} ${r(b.x)} ${r(b.y)}`;
}
