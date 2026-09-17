import type { RacerId } from '@mr/engine';
import { useState } from 'react';
import { ActionBar, PlayerToken, RacerCard, Waiting } from '../components/bits';
import { awardsFor, listNames, racerName, rawName, trackLabel, waitingOn } from '../lib/present';
import { legalOf, useRoomContext } from '../lib/roomContext';

/**
 * Secret selection of this race's racer.
 *
 * Two taps — select, then lock in — because the choice is irrevocable and a stray tap
 * while scrolling a phone should not spend a racer.
 */
export function CommitScreen() {
  const { view, message, canAct, send } = useRoomContext();
  const [selected, setSelected] = useState<RacerId | null>(null);
  if (view.phase.t !== 'commit') return null;

  const phase = view.phase;
  const awards = awardsFor(phase.raceNo);
  const legal = legalOf(message, 'race/commit');
  const hand = view.hands[view.you] ?? [];
  const used = view.used[view.you] ?? [];
  const locked = phase.yourCommit;
  const others = waitingOn(view).filter((p) => p !== view.you);

  const lockIn = (): void => {
    const action = legal.find((a) => a.racerId === selected);
    if (action) send(action);
  };

  return (
    <>
      <main className="page">
        <section className="card stack">
          <p className="section-title">
            Race {phase.raceNo} of 4 · {trackLabel(phase.raceNo)}
          </p>
          <h1 style={{ fontSize: '1.5rem' }}>{locked ? 'Locked in' : 'Choose your racer'}</h1>
          <p className="muted">
            1st takes {awards.gold} points, 2nd takes {awards.silver}. Everyone reveals at once — nobody sees your pick
            until then.
          </p>
        </section>

        <section className="stack" aria-label="Your racers">
          <div className="racer-grid">
            {hand.map((racer) => {
              const spent = used.includes(racer);
              const chosen = locked === racer;
              return (
                <RacerCard
                  key={racer}
                  racer={racer}
                  selected={selected === racer || chosen}
                  dim={spent || (locked !== null && !chosen)}
                  disabled={spent || locked !== null || !canAct}
                  onSelect={() => setSelected(racer)}
                  footer={
                    spent ? (
                      <span className="tag">already raced</span>
                    ) : chosen ? (
                      <span className="tag tag-good">locked in</span>
                    ) : null
                  }
                />
              );
            })}
          </div>
        </section>

        <section className="card" aria-labelledby="ready-heading">
          <h2 id="ready-heading" className="section-title" style={{ marginBottom: 4 }}>
            Ready?
          </h2>
          {view.seatOrder.map((pid) => {
            const ready = phase.committedBy.includes(pid);
            return (
              <div key={pid} className="player-row">
                <PlayerToken view={view} pid={pid} size={30} />
                <span className="name">
                  {rawName(view, pid)}
                  {pid === view.you && <span className="muted"> (you)</span>}
                </span>
                <span className={`tag${ready ? ' tag-good' : ''}`}>{ready ? 'locked in' : 'choosing…'}</span>
              </div>
            );
          })}
        </section>
      </main>

      <ActionBar>
        {locked === null && legal.length > 0 ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!selected || !canAct} onClick={lockIn}>
            {selected ? `Lock in ${racerName(selected)}` : 'Tap a racer to choose'}
          </button>
        ) : (
          <Waiting>{others.length > 0 ? `Waiting for ${listNames(view, others)}` : 'Revealing…'}</Waiting>
        )}
      </ActionBar>
    </>
  );
}
