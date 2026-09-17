import { FINISH, type RacerId, type RaceNumber } from '@mr/engine';
import { useState } from 'react';
import { Board } from '../components/Board';
import { ActionBar, RacerToken, Standings, Waiting } from '../components/bits';
import { ordinal, playerName, powerText, racerName, rawName } from '../lib/present';
import { legalOf, useRoomContext } from '../lib/roomContext';

/**
 * The race. Also shown briefly in the `scored` phase, while the move that ended the race
 * finishes animating — see `useFinishHold`.
 */
export function RaceScreen() {
  const { view, log, board } = useRoomContext();
  const [showFullLog, setShowFullLog] = useState(false);

  if (view.phase.t !== 'racing' && view.phase.t !== 'scored') return null;
  const phase = view.phase;
  const racing = phase.t === 'racing';
  const active = racing ? phase.active : null;

  const targets: RacerId[] = (view.pending?.options ?? []).flatMap((o) =>
    o.target?.t === 'racer' ? [o.target.racerId] : [],
  );

  // The list describes what the board is *drawing*, which lags the true state while moves
  // animate. Otherwise it announces "1st" while the winner is still visibly mid-track.
  const drawn = (id: RacerId, pos: number): number => board.positions[id] ?? pos;
  const arrived = (r: (typeof view.board)[number]): boolean =>
    r.finishedRank !== null && drawn(r.racerId, r.pos) >= FINISH;

  // Leader first; arrived racers by rank ahead of everyone; eliminated at the bottom.
  const field = [...view.board].sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    const ra = arrived(a) ? (a.finishedRank ?? 99) : 99;
    const rb = arrived(b) ? (b.finishedRank ?? 99) : 99;
    if (ra !== rb) return ra - rb;
    return drawn(b.racerId, b.pos) - drawn(a.racerId, a.pos);
  });

  const visibleLog = showFullLog ? log : log.slice(0, 6);

  return (
    <>
      <main className="page page-wide">
        <StatusBanner />
        <div className="race-layout">
          <div className="stack">
            <section className="card" style={{ padding: 10 }}>
              <Board
                view={view}
                raceNo={phase.raceNo as RaceNumber}
                positions={board.positions}
                highlight={targets}
                claimedSpaces={racing ? phase.claimedSpaces : []}
              />
            </section>
          </div>

          <div className="stack">
            <section className="card" aria-labelledby="field-heading">
              <h2 id="field-heading" className="section-title">
                On the track
              </h2>
              {field.map((r) => (
                <div key={r.racerId} className="field-row" data-out={r.eliminated}>
                  <RacerToken view={view} racer={r.racerId} owner={r.owner} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 750 }}>
                      {racerName(r.racerId)}{' '}
                      <span className="who">· {r.owner === view.you ? 'you' : rawName(view, r.owner)}</span>
                    </div>
                    <p className="power">{powerText(r.racerId)}</p>
                  </div>
                  <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
                    {arrived(r) && r.finishedRank !== null ? (
                      <span className="tag tag-gold">{ordinal(r.finishedRank)}</span>
                    ) : r.eliminated ? (
                      <span className="tag tag-bad">out</span>
                    ) : (
                      <span className="tag num">
                        {drawn(r.racerId, r.pos) === 0 ? 'start' : `space ${Math.min(drawn(r.racerId, r.pos), FINISH - 1)}`}
                      </span>
                    )}
                    {r.tripped && <span className="tag tag-bad">tripped</span>}
                    {r.owner === active && r.finishedRank === null && <span className="tag tag-gold">turn</span>}
                  </div>
                </div>
              ))}
            </section>

            <section className="card" aria-labelledby="log-heading">
              <div className="spread" style={{ marginBottom: 8 }}>
                <h2 id="log-heading" className="section-title">
                  What happened
                </h2>
                {log.length > 6 && (
                  <button type="button" className="btn btn-ghost" style={{ minHeight: 32, padding: '0 8px' }} onClick={() => setShowFullLog((v) => !v)}>
                    {showFullLog ? 'Less' : `All ${log.length}`}
                  </button>
                )}
              </div>
              {log.length === 0 ? (
                <p className="muted">The race is about to begin.</p>
              ) : (
                <ol className="log" aria-live="polite">
                  {visibleLog.map((line) => (
                    <li key={line.id} data-tone={line.tone}>
                      {line.text}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="card" aria-labelledby="standings-heading">
              <h2 id="standings-heading" className="section-title">
                Standings
              </h2>
              <Standings view={view} />
            </section>
          </div>
        </div>
      </main>

      <RaceActions />
    </>
  );
}

function StatusBanner() {
  const { view } = useRoomContext();
  if (view.phase.t === 'scored') {
    return (
      <p className="banner banner-you" aria-live="polite">
        Race over!
      </p>
    );
  }
  if (view.phase.t !== 'racing') return null;
  const phase = view.phase;
  const pending = view.pending;

  let text: string;
  let mine = false;
  if (pending) {
    mine = pending.player === view.you;
    text = mine ? `${racerName(pending.source)} needs your decision` : `Waiting on ${playerName(view, pending.player)} — ${racerName(pending.source)}`;
  } else {
    mine = phase.active === view.you;
    const racer = view.board.find((r) => r.owner === phase.active);
    text = mine
      ? `Your turn${racer ? ` — ${racerName(racer.racerId)}` : ''}`
      : `${playerName(view, phase.active)}'s turn${racer ? ` — ${racerName(racer.racerId)}` : ''}`;
  }

  return (
    <p className={`banner${mine ? ' banner-you' : ''}`} aria-live="polite">
      {text}
    </p>
  );
}

function RaceActions() {
  const { view, message, canAct, send } = useRoomContext();
  if (view.phase.t === 'scored') {
    return (
      <ActionBar wide>
        <Waiting>And that's the race…</Waiting>
      </ActionBar>
    );
  }
  if (view.phase.t !== 'racing') return null;
  const phase = view.phase;
  const pending = view.pending;

  const decisions = legalOf(message, 'race/decide');
  const roll = legalOf(message, 'race/roll')[0];
  const mine = view.board.find((r) => r.owner === view.you);

  if (pending && decisions.length > 0) {
    return (
      <ActionBar wide>
        <p className="prompt">{pending.prompt}</p>
        <div className="options">
          {decisions.map((d, i) => {
            const label = pending.options.find((o) => o.id === d.choice)?.label ?? d.choice;
            return (
              <button
                key={d.choice}
                type="button"
                className={`btn btn-lg${i === 0 ? ' btn-primary' : ''}`}
                disabled={!canAct}
                onClick={() => send(d)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </ActionBar>
    );
  }

  if (roll) {
    return (
      <ActionBar wide>
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!canAct} onClick={() => send(roll)}>
          {mine?.tripped ? 'Stand back up' : 'Roll'}
        </button>
      </ActionBar>
    );
  }

  const done = mine && (mine.finishedRank !== null || mine.eliminated || mine.pos >= FINISH);
  return (
    <ActionBar wide>
      <Waiting>
        {pending
          ? `${playerName(view, pending.player)} ${pending.player === view.you ? 'are' : 'is'} deciding…`
          : done
            ? `Your racer is ${mine?.eliminated ? 'out' : 'home'} — ${playerName(view, phase.active)}'s turn`
            : `${playerName(view, phase.active)}'s turn`}
      </Waiting>
    </ActionBar>
  );
}
