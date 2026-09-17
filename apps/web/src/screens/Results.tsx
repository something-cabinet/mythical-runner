import { totalPoints, type RaceNumber } from '@mr/engine';
import { ActionBar, PlayerToken, Standings, Waiting } from '../components/bits';
import { awardsFor, playerName, racerName, rawName, trackLabel } from '../lib/present';
import { legalOf, useRoomContext } from '../lib/roomContext';

export function ResultsScreen() {
  const { view, message, canAct, send } = useRoomContext();
  if (view.phase.t !== 'scored') return null;

  const raceNo = view.phase.raceNo as RaceNumber;
  const awards = awardsFor(raceNo);
  const next = legalOf(message, 'race/continue')[0];

  const byRank = (rank: number) => view.board.find((r) => r.finishedRank === rank);
  const first = byRank(1);
  const second = byRank(2);

  const earned = view.seatOrder
    .map((pid) => ({
      pid,
      pts: totalPoints((view.scores[pid] ?? []).filter((t) => t.raceNo === raceNo)),
    }))
    .sort((a, b) => b.pts - a.pts);

  return (
    <>
      <main className="page page-wide">
        <section className="card stack" style={{ textAlign: 'center' }}>
          <p className="section-title">
            Race {raceNo} of 4 · {trackLabel(raceNo)}
          </p>
          <h1 style={{ fontSize: '1.7rem' }}>Race {raceNo} results</h1>
        </section>

        <section className="podium" aria-label="Podium">
          <div className="place place-gold">
            <p className="medal">1st · gold · {awards.gold} pts</p>
            {first ? (
              <>
                <p className="racer">{racerName(first.racerId)}</p>
                <p className="muted">{playerName(view, first.owner)}</p>
              </>
            ) : (
              <p className="muted">Nobody finished</p>
            )}
          </div>
          <div className="place">
            <p className="medal">2nd · silver · {awards.silver} pts</p>
            {second ? (
              <>
                <p className="racer">{racerName(second.racerId)}</p>
                <p className="muted">{playerName(view, second.owner)}</p>
              </>
            ) : (
              // M.O.U.T.H.'s card: "no one gets those points and you can discard that
              // race's silver rosette."
              <p className="muted">No second place</p>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="earned-heading">
          <h2 id="earned-heading" className="section-title" style={{ marginBottom: 4 }}>
            Points this race
          </h2>
          {earned.map(({ pid, pts }) => (
            <div key={pid} className="player-row">
              <PlayerToken view={view} pid={pid} size={30} />
              <span className="name">
                {rawName(view, pid)}
                {pid === view.you && <span className="muted"> (you)</span>}
              </span>
              <span className="big-points num">+{pts}</span>
            </div>
          ))}
        </section>

        <section className="card" aria-labelledby="total-heading">
          <h2 id="total-heading" className="section-title">
            Standings after race {raceNo}
          </h2>
          <Standings view={view} />
        </section>
      </main>

      <ActionBar wide>
        {next ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!canAct} onClick={() => send(next)}>
            {raceNo >= 4 ? 'See final results' : `On to race ${raceNo + 1}`}
          </button>
        ) : (
          <Waiting>Waiting to continue…</Waiting>
        )}
      </ActionBar>
    </>
  );
}
