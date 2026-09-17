import { currentDrafter, racersPerPlayer, type PlayerId, type RacerId } from '@mr/engine';
import { useEffect, useState } from 'react';
import { ActionBar, PlayerToken, RacerCard, Waiting } from '../components/bits';
import { listNames, playerName, racerName, rawName, waitingOn } from '../lib/present';
import { legalOf, useRoomContext } from '../lib/roomContext';

/** Covers both the roll-off for draft order and the snake draft itself. */
export function DraftScreen() {
  const { view } = useRoomContext();
  return view.phase.t === 'draftRoll' ? <RollOff /> : <Picking />;
}

function RollOff() {
  const { view, message, canAct, send } = useRoomContext();
  if (view.phase.t !== 'draftRoll') return null;
  const rolls = view.phase.rolls;
  const myRoll = legalOf(message, 'draft/roll')[0];
  const outstanding = waitingOn(view).filter((p) => p !== view.you);

  return (
    <>
      <main className="page">
        <section className="card stack">
          <h1 style={{ fontSize: '1.5rem' }}>Roll for draft order</h1>
          <p className="muted">Highest roll picks first. Anyone who ties rolls again.</p>
        </section>

        <section className="card">
          {view.seatOrder.map((pid) => {
            const value = rolls[pid] ?? null;
            return (
              <div key={pid} className="player-row">
                <PlayerToken view={view} pid={pid} />
                <span className="name">{rawName(view, pid)}{pid === view.you && <span className="muted"> (you)</span>}</span>
                <span className="die num" data-empty={value === null} aria-label={value === null ? 'not rolled' : `rolled ${value}`}>
                  {value ?? '?'}
                </span>
              </div>
            );
          })}
        </section>
      </main>

      <ActionBar>
        {myRoll ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!canAct} onClick={() => send(myRoll)}>
            Roll the die
          </button>
        ) : (
          <Waiting>
            {outstanding.length > 0 ? `Waiting for ${listNames(view, outstanding)} to roll` : 'Settling the order…'}
          </Waiting>
        )}
      </ActionBar>
    </>
  );
}

function Picking() {
  const { view, message, canAct, send } = useRoomContext();
  const [selected, setSelected] = useState<RacerId | null>(null);
  const pick = view.phase.t === 'draft' ? view.phase.pick : -1;

  // A new pick means a new layout; a stale selection could name a racer that is gone.
  useEffect(() => setSelected(null), [pick]);

  if (view.phase.t !== 'draft') return null;
  const phase = view.phase;

  const picker = currentDrafter(phase.order, phase.pick);
  const legalPicks = legalOf(message, 'draft/pick');
  const myTurn = legalPicks.length > 0;
  const perPlayer = racersPerPlayer(phase.order.length);
  const total = phase.order.length * perPlayer;
  const round = Math.floor(phase.pick / phase.order.length);
  const myHand = view.hands[view.you] ?? [];

  const choose = (): void => {
    const action = legalPicks.find((a) => a.racerId === selected);
    if (action) send(action);
  };

  return (
    <>
      <main className="page">
        <p className={`banner${myTurn ? ' banner-you' : ''}`} aria-live="polite">
          {myTurn ? 'Your pick — choose a racer for your team' : `${playerName(view, picker)} ${picker === view.you ? 'are' : 'is'} picking`}
          <span className="muted" style={{ display: 'block', fontWeight: 500, fontSize: '0.85rem' }}>
            Pick {Math.min(phase.pick + 1, total)} of {total} · round {round + 1}{' '}
            {round % 2 === 0 ? '(forward)' : '(snaking back)'}
          </span>
        </p>

        <section className="stack" aria-labelledby="pool-heading">
          <h2 id="pool-heading" className="section-title">
            Available racers
          </h2>
          <div className="racer-grid">
            {phase.layout.map((racer) => (
              <RacerCard
                key={racer}
                racer={racer}
                selected={selected === racer}
                disabled={!myTurn || !canAct}
                onSelect={() => setSelected(racer)}
              />
            ))}
          </div>
        </section>

        <section className="stack" aria-labelledby="team-heading">
          <h2 id="team-heading" className="section-title">
            Your team · {myHand.length}/{perPlayer}
          </h2>
          {myHand.length === 0 ? (
            <p className="muted">Nobody yet.</p>
          ) : (
            <div className="racer-grid">
              {myHand.map((racer) => (
                <RacerCard key={racer} racer={racer} />
              ))}
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="teams-heading">
          <h2 id="teams-heading" className="section-title" style={{ marginBottom: 4 }}>
            Draft order &amp; teams
          </h2>
          {phase.order.map((pid: PlayerId) => (
            <div key={pid} className="player-row" style={{ alignItems: 'flex-start' }}>
              <PlayerToken view={view} pid={pid} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">
                  {rawName(view, pid)}
                  {pid === view.you && <span className="muted"> (you)</span>}
                </div>
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  {(view.hands[pid] ?? []).map(racerName).join(' · ') || '—'}
                </div>
              </div>
              {pid === picker && <span className="tag tag-gold">picking</span>}
            </div>
          ))}
        </section>
      </main>

      <ActionBar>
        {myTurn ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!selected || !canAct} onClick={choose}>
            {selected ? `Draft ${racerName(selected)}` : 'Tap a racer to choose'}
          </button>
        ) : (
          <Waiting>{playerName(view, picker)} {picker === view.you ? 'are' : 'is'} picking…</Waiting>
        )}
      </ActionBar>
    </>
  );
}
