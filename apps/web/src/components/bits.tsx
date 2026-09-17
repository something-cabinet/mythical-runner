import type { PlayerId, PlayerView, RacerId } from '@mr/engine';
import { useEffect, useState, type ReactNode } from 'react';
import {
  hasSprite,
  initials,
  points,
  powerText,
  racerInitials,
  racerName,
  racerSprite,
  racerText,
  rawName,
  seatColor,
  SEAT_INK,
} from '../lib/present';

/** A player's coloured disc. Always carries initials, so colour is never the only cue. */
export function PlayerToken({ view, pid, size = 34 }: { view: PlayerView; pid: PlayerId; size?: number }) {
  return (
    <span
      className="token"
      aria-hidden="true"
      style={{ background: seatColor(view, pid), color: SEAT_INK, ['--size' as string]: `${size}px` }}
    >
      {initials(rawName(view, pid))}
    </span>
  );
}

/**
 * A racer's disc, in its owner's colour, carrying the racer's portrait — or its initials
 * where there is no art yet, matching the board. The stand-in face is the same for every
 * racer that lacks art, so it would make a row of them indistinguishable.
 *
 * The portrait is the racer, never the card it is currently running: an Egg that hatched
 * into Ostrich is still an Egg on the track, so it keeps the Egg's face.
 */
export function RacerToken({
  view,
  racer,
  owner,
  size = 34,
}: {
  view: PlayerView;
  racer: RacerId;
  owner: PlayerId;
  size?: number;
}) {
  const art = hasSprite(racer);
  return (
    <span
      className={`token${art ? ' token-sprite' : ''}`}
      aria-hidden="true"
      style={{ background: seatColor(view, owner), color: SEAT_INK, ['--size' as string]: `${size}px` }}
    >
      {art ? <img src={racerSprite(racer)} alt="" /> : racerInitials(racer)}
    </span>
  );
}

/**
 * A racer card: portrait, name and full power text.
 *
 * Power text is never truncated or hidden behind a tap. With thirty-six rule-breaking
 * powers, not being able to see what a racer does is the single easiest way for this game
 * to become unplayable.
 */
export function RacerCard({
  racer,
  selected = false,
  disabled = false,
  dim = false,
  footer,
  onSelect,
}: {
  racer: RacerId;
  selected?: boolean;
  disabled?: boolean;
  dim?: boolean;
  footer?: ReactNode;
  onSelect?: () => void;
}) {
  const vanilla = racerText(racer) === '';
  const interactive = !!onSelect && !disabled;
  return (
    <button
      type="button"
      className="racer-card"
      aria-pressed={interactive ? selected : undefined}
      data-dim={dim}
      data-vanilla={vanilla}
      disabled={!interactive}
      onClick={onSelect}
    >
      <span className="racer-sprite" aria-hidden="true">
        <img src={racerSprite(racer)} alt="" data-placeholder={!hasSprite(racer)} loading="lazy" />
      </span>
      <span className="racer-name">{racerName(racer)}</span>
      <span className="racer-power">{powerText(racer)}</span>
      {footer}
    </button>
  );
}

/** Running totals, highest first. Ties share a rank. */
export function Standings({ view }: { view: PlayerView }) {
  const rows = [...view.players]
    .map((p) => ({ p, pts: points(view, p.id) }))
    .sort((a, b) => b.pts - a.pts);

  return (
    <div>
      {rows.map(({ p, pts }) => {
        const rank = rows.findIndex((r) => r.pts === pts) + 1;
        return (
          <div key={p.id} className={`player-row${p.connected ? '' : ' offline'}`}>
            <span className="muted num" style={{ width: 18 }}>
              {rank}
            </span>
            <PlayerToken view={view} pid={p.id} size={30} />
            <span className="name">
              {p.name}
              {p.id === view.you && <span className="muted"> (you)</span>}
            </span>
            {!p.connected && <span className="tag">away</span>}
            <span className="big-points num">{pts}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A clock that re-renders on an interval. Kept local so only the countdown re-renders. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Countdown({ deadline }: { deadline: number | null }) {
  const now = useNow(250);
  if (deadline === null) return null;
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  const text = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
  return (
    <span className="countdown num" data-urgent={secs <= 10} aria-label={`${secs} seconds left`}>
      {text}
    </span>
  );
}

/** Pinned to the bottom of the screen, where a thumb can reach the next move. */
export function ActionBar({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="actionbar">
      <div className={`actionbar-inner${wide ? ' actionbar-inner-wide' : ''}`}>{children}</div>
    </div>
  );
}

export function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="waiting" aria-live="polite">
      {children}
    </p>
  );
}

/** A short-lived message. Re-announces when `message` changes. */
export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onDone, 2600);
    return () => clearTimeout(id);
  }, [message, onDone]);

  if (!message) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'calc(110px + env(safe-area-inset-bottom))',
        transform: 'translateX(-50%)',
        zIndex: 50,
        maxWidth: 'calc(100% - 32px)',
      }}
      className="banner banner-warn"
    >
      {message}
    </div>
  );
}
