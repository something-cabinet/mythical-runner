import { racersPerRace, type RacerId } from '@mr/engine';
import { useEffect, useState } from 'react';
import { ActionBar, RacerCard, ReadyStrip, Waiting } from '../components/bits';
import { awardsFor, listNames, racerName, trackLabel, waitingOn } from '../lib/present';
import { legalOf, useRoomContext } from '../lib/roomContext';

/**
 * Secret selection of this race's racer — or racers: the two-player variant enters two
 * each, locked in one at a time.
 *
 * Two taps — select, then lock in — because the choice is irrevocable and a stray tap
 * while scrolling a phone should not spend a racer.
 */
export function CommitScreen() {
  const { view, message, canAct, send } = useRoomContext();
  const [selected, setSelected] = useState<RacerId | null>(null);
  const entered = view.phase.t === 'commit' ? view.phase.yourCommit.length : 0;
  // A racer just locked in is no longer a legal choice; clear the selection so the next
  // pick starts from nothing.
  useEffect(() => setSelected(null), [entered]);
  if (view.phase.t !== 'commit') return null;

  const phase = view.phase;
  const awards = awardsFor(phase.raceNo);
  const legal = legalOf(message, 'race/commit');
  const hand = view.hands[view.you] ?? [];
  const used = view.used[view.you] ?? [];
  const locked = phase.yourCommit;
  const need = racersPerRace(view.seatOrder.length);
  const done = locked.length >= need;
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
          <h1 style={{ fontSize: '1.5rem' }}>
            {done ? 'Locked in' : need > 1 ? `Choose ${need - locked.length} more racer${need - locked.length === 1 ? '' : 's'}` : 'Choose your racer'}
          </h1>
          <p className="muted">
            1st takes {awards.gold} points, 2nd takes {awards.silver}. Everyone reveals at once — nobody sees your{' '}
            {need > 1 ? 'picks' : 'pick'} until then.
            {need > 1 && ' With two players you race two different racers each.'}
          </p>
        </section>

        <section className="stack" aria-label="Your racers">
          <div className="card card-stage" style={{ padding: 10 }}>
            <div className="racer-grid">
              {hand.map((racer) => {
                const spent = used.includes(racer);
                const chosen = locked.includes(racer);
                return (
                  <RacerCard
                    view={view}
                    key={racer}
                    racer={racer}
                    selected={selected === racer || chosen}
                    dim={spent || (done && !chosen)}
                    disabled={spent || chosen || done || !canAct}
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
          </div>
        </section>

        <section className="card" aria-labelledby="ready-heading">
          <h2 id="ready-heading" className="section-title" style={{ marginBottom: 8 }}>
            Ready?
          </h2>
          <ReadyStrip view={view} seatOrder={view.seatOrder} readyIds={phase.committedBy} />
        </section>
      </main>

      <ActionBar>
        {!done && legal.length > 0 ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!selected || !canAct} onClick={lockIn}>
            {selected ? `Lock in ${racerName(view, selected)}` : 'Tap a racer to choose'}
          </button>
        ) : (
          <Waiting>{others.length > 0 ? `Waiting for ${listNames(view, others)}` : 'Revealing…'}</Waiting>
        )}
      </ActionBar>
    </>
  );
}
