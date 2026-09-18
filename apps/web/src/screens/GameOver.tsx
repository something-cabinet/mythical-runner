import { RACE_COUNT, totalPoints, type RaceNumber } from '@mr/engine';
import type { CSSProperties } from 'react';
import { ActionBar, PlayerToken } from '../components/bits';
import { playerName, points, rawName } from '../lib/present';
import { legalOf, useRoomContext } from '../lib/roomContext';
import { navigate } from '../lib/router';

// Fixed confetti pieces: fixed positions and colors read as intentional set-dressing for
// the one true celebration screen in the game, not as decoration scattered for its own
// sake. `prefers-reduced-motion` hides the whole layer.
const CONFETTI = [
  { x: '6%', c: 'var(--accent-bg)', d: '0ms' },
  { x: '18%', c: 'var(--coral)', d: '120ms' },
  { x: '32%', c: 'var(--power)', d: '60ms' },
  { x: '46%', c: 'var(--accent-bg)', d: '200ms' },
  { x: '58%', c: 'var(--coral)', d: '20ms' },
  { x: '70%', c: 'var(--power)', d: '160ms' },
  { x: '82%', c: 'var(--accent-bg)', d: '90ms' },
  { x: '94%', c: 'var(--coral)', d: '240ms' },
] as const;

export function GameOverScreen() {
  const { view, message, canAct, send } = useRoomContext();
  const rematch = legalOf(message, 'lobby/rematch')[0];
  if (view.phase.t !== 'gameOver') return null;

  const winners = view.phase.winners;
  const youWon = winners.includes(view.you);
  const headline =
    winners.length > 1
      ? `A tie between ${winners.map((w) => (w === view.you ? 'you' : playerName(view, w))).join(' & ')}!`
      : youWon
        ? 'You win!'
        : `${playerName(view, winners[0] ?? view.you)} wins!`;

  const rows = [...view.seatOrder].sort((a, b) => points(view, b) - points(view, a));
  const races = Array.from({ length: RACE_COUNT }, (_, i) => (i + 1) as RaceNumber);

  return (
    <>
      <main className="page">
        <section className="card winner" aria-live="polite">
          {youWon && (
            <div className="confetti" aria-hidden="true">
              {CONFETTI.map((piece, i) => (
                <span
                  key={i}
                  className="confetti-piece"
                  style={{ '--x': piece.x, '--c': piece.c, '--d': piece.d } as CSSProperties}
                />
              ))}
            </div>
          )}
          <p className="section-title">Game over</p>
          <h1 style={{ fontSize: '2rem', marginTop: 6 }}>{headline}</h1>
          {winners.length > 1 && <p className="muted" style={{ marginTop: 6 }}>No tiebreaker — celebrate together.</p>}
        </section>

        <section className="card" aria-labelledby="final-heading">
          <h2 id="final-heading" className="section-title" style={{ marginBottom: 4 }}>
            Final scores
          </h2>
          {rows.map((pid, i) => (
            <div
              key={pid}
              className="player-row stagger-in"
              style={{ alignItems: 'flex-start', '--i': i } as CSSProperties}
            >
              <PlayerToken view={view} pid={pid} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">
                  {rawName(view, pid)}
                  {pid === view.you && <span className="muted"> (you)</span>}
                  {winners.includes(pid) && <span className="tag tag-gold" style={{ marginLeft: 8 }}>winner</span>}
                </div>
                <div className="muted num" style={{ fontSize: '0.82rem' }}>
                  {races
                    .map((r) => `R${r}: ${totalPoints((view.scores[pid] ?? []).filter((t) => t.raceNo === r))}`)
                    .join(' · ')}
                </div>
              </div>
              <span className="big-points num">{points(view, pid)}</span>
            </div>
          ))}
        </section>
      </main>

      <ActionBar>
        {rematch && (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={!canAct}
            onClick={() => send(rematch)}
          >
            Play again
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-block" onClick={() => navigate('/')}>
          Leave for home
        </button>
      </ActionBar>
    </>
  );
}
