import { FINISH, RACE_COUNT, type RacerId, type RaceNumber } from '@mr/engine';
import { useState } from 'react';
import { Board3D } from '../components/Board3D';
import { ActionBar, HudBar, RacerCard, RacerToken, Standings, Waiting } from '../components/bits';
import { abilityToken, borrowedPower, ordinal, playerName, points, powerText, racerName, rawName } from '../lib/present';
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
  // The racer up right now, and everyone the active player still has to move this turn.
  // An owed extra turn (Ogre Magi, Genius) is up before the player chooses between racers.
  const upNow = racing
    ? (phase.moving ?? phase.extraTurns[0] ?? (phase.toMove.length === 1 ? (phase.toMove[0] ?? null) : null))
    : null;
  const upThisTurn = racing ? [...phase.toMove, ...(phase.moving ? [phase.moving] : [])] : [];
  // An opening turn moves one racer of the player's choosing, so the others are candidates
  // rather than a queue.
  const opening = racing && !phase.opened.includes(phase.active);

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

  // Dota-style HUD readout: how many racers are home vs. still running this heat, who is
  // leading the whole match on points, and where you personally stand.
  const home = view.board.filter((r) => arrived(r)).length;
  const running = view.board.length - home;
  const standings = [...view.players]
    .map((p) => ({ p, pts: points(view, p.id) }))
    .sort((a, b) => b.pts - a.pts);
  const leaderRow = standings[0] ?? null;
  const leader = leaderRow ? { name: rawName(view, leaderRow.p.id), pts: leaderRow.pts, mine: leaderRow.p.id === view.you } : null;
  const youRow = standings.find((s) => s.p.id === view.you) ?? null;
  const you = youRow ? { pts: youRow.pts, rank: standings.findIndex((s) => s.pts === youRow.pts) + 1 } : null;

  return (
    <>
      <main className="page page-wide race-page">
        <div className="race-kicker">
          <span className="race-kicker-mark" aria-hidden="true">✦</span>
          <span>Mythical Circuit</span>
          <span className="race-kicker-rule" aria-hidden="true" />
          <span className="num">Race {phase.raceNo}</span>
        </div>
        <HudBar
          raceNo={phase.raceNo}
          totalRaces={RACE_COUNT}
          home={home}
          running={running}
          leader={leader}
          you={you}
        />
        <StatusBanner />
        <div className="race-layout">
          <section className="race-arena">
            <div className="arena-topline">
              <div>
                <p className="eyebrow">The enchanted track</p>
                <h1>Dash to the finish</h1>
              </div>
              <span className="arena-badge"><span className="live-dot" /> Live match</span>
            </div>
            <div className="card race-board" style={{ padding: 10 }}>
            <Board3D
              view={view}
              raceNo={phase.raceNo as RaceNumber}
              positions={board.positions}
              highlight={targets}
              claimedSpaces={racing ? phase.claimedSpaces : []}
              roll={board.roll}
              activeRacer={
                // Follow the die while its move plays out; the server has already moved on.
                board.roll ? board.roll.racerId : upNow
              }
            />
            </div>
          </section>

          <div className="stack race-side-panel">
            <section className="card" aria-labelledby="field-heading">
              <h2 id="field-heading" className="section-title">
                On the track
              </h2>
              {field.map((r) => {
                // An Egg that hatched into Ostrich runs Ostrich's card, so that is the name
                // and the power worth reading; its own name stays alongside, because the
                // token on the track is still an Egg.
                const power = borrowedPower(view, r);
                const ability = r.finishedRank === null && !r.eliminated ? abilityToken(r, power ?? r.racerId) : null;
                return (
                  <div key={r.racerId} className="field-row" data-out={r.eliminated}>
                    <RacerToken view={view} racer={r.racerId} owner={r.owner} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 750 }}>
                        {racerName(view, power ?? r.racerId)}{' '}
                        {power && <span className="who">(as {racerName(view, r.racerId)}) </span>}
                        <span className="who">· {r.owner === view.you ? 'you' : rawName(view, r.owner)}</span>
                      </div>
                      <p className="power">{powerText(power ?? r.racerId)}</p>
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
                      {ability && (
                        <span className={`tag${ability.ready ? ' tag-good' : ''}`} title={ability.title}>
                          {ability.label}
                        </span>
                      )}
                      {upThisTurn.includes(r.racerId) && r.finishedRank === null && (
                        <span className="tag tag-gold">
                          {r.racerId === upNow ? 'turn' : opening ? 'choose' : 'to go'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          </div>

          <div className="stack">
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
    text = mine ? `${racerName(view, pending.source)} needs your decision` : `Waiting on ${playerName(view, pending.player)} — ${racerName(view, pending.source)}`;
  } else {
    mine = phase.active === view.you;
    // With two racers to run, the turn belongs to the player until they have moved both;
    // name whichever one is up, or say there is still a choice to make.
    // An extra turn (Ogre Magi, Genius) is owed before the player chooses between racers.
    const up = phase.moving ?? phase.extraTurns[0] ?? (phase.toMove.length === 1 ? phase.toMove[0] : null);
    const which = up ? ` — ${racerName(view, up)}` : phase.toMove.length > 1 ? ' — pick a racer' : '';
    text = mine ? `Your turn${which}` : `${playerName(view, phase.active)}'s turn${which}`;
  }

  return (
    <p className={`banner${mine ? ' banner-you' : ''}`} aria-live="polite">
      {text}
    </p>
  );
}

function RaceActions() {
  const { view, message, canAct, send, board } = useRoomContext();
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
  const rolls = legalOf(message, 'race/roll');
  const myRacers = view.board.filter((r) => r.owner === view.you);

  if (pending && decisions.length > 0) {
    // A power asking about a roll asks while that roll is still tumbling across the
    // infield. Nobody should have to answer for a die they have not seen land, so the
    // choices wait for the board to catch up.
    const held = !canAct || board.animating;
    const choices = decisions.map((d) => ({
      action: d,
      option: pending.options.find((o) => o.id === d.choice),
    }));
    // An option about a racer gets that racer's card, as in the draft: Egg is choosing
    // between three powers, and three names say nothing about what they do. The verb —
    // "DUEL!", "Swap with Gunk" — stays on the card as its button text.
    const cards = choices.flatMap(({ action, option }) =>
      option?.target?.t === 'racer' ? [{ action, option, racer: option.target.racerId }] : [],
    );
    const plain = choices.filter(({ option }) => option?.target?.t !== 'racer');

    return (
      <ActionBar wide>
        <p className="prompt">{pending.prompt}</p>
        {cards.length > 0 && (
          <div className="racer-grid">
            {cards.map(({ action, option, racer }) => (
              <RacerCard
                view={view}
                key={action.choice}
                racer={racer}
                disabled={held}
                onSelect={() => send(action)}
                footer={
                  <span className="racer-pick">
                    {option.label === racerName(view, racer) ? 'Choose' : option.label}
                  </span>
                }
              />
            ))}
          </div>
        )}
        {plain.length > 0 && (
          <div className="options">
            {plain.map(({ action, option }, i) => (
              <button
                key={action.choice}
                type="button"
                className={`btn btn-lg${cards.length === 0 && i === 0 ? ' btn-primary' : ''}`}
                disabled={held}
                onClick={() => send(action)}
              >
                {option?.label ?? action.choice}
              </button>
            ))}
          </div>
        )}
      </ActionBar>
    );
  }

  if (rolls.length > 0) {
    // The server sends a whole turn at once, so the state handing us the next turn arrives
    // while the previous one is still walking across the board. Offering the roll then
    // would put a live button under a racer the player can see is still moving — and on
    // someone else's turn, from their point of view. The bar waits for the board to catch
    // up, the same rule the decision branch above follows.
    if (board.animating) {
      return (
        <ActionBar wide>
          <Waiting>Racing…</Waiting>
        </ActionBar>
      );
    }

    // One button per racer still to move: "you use each of your racers in the order you
    // want", so the choice of who goes next is the player's, one at a time.
    const label = (racerId: RacerId | undefined): string => {
      const racer = racerId ? view.board.find((r) => r.racerId === racerId) : myRacers[0];
      const verb = racer?.tripped ? 'Stand up' : 'Roll';
      return rolls.length > 1 && racer ? `${verb} · ${racerName(view, racer.racerId)}` : verb;
    };
    return (
      <ActionBar wide>
        {rolls.length > 1 && <p className="prompt">Which racer goes next?</p>}
        <div className={rolls.length > 1 ? 'options' : undefined}>
          {rolls.map((action, i) => (
            <button
              key={action.racerId ?? i}
              type="button"
              className={`btn btn-lg${i === 0 ? ' btn-primary' : ''}${rolls.length > 1 ? '' : ' btn-block'}`}
              disabled={!canAct}
              onClick={() => send(action)}
            >
              {label(action.racerId)}
            </button>
          ))}
        </div>
      </ActionBar>
    );
  }

  const done =
    myRacers.length > 0 &&
    myRacers.every((r) => r.finishedRank !== null || r.eliminated || r.pos >= FINISH);
  const out = myRacers.every((r) => r.eliminated);
  return (
    <ActionBar wide>
      <Waiting>
        {pending
          ? `${playerName(view, pending.player)} ${pending.player === view.you ? 'are' : 'is'} deciding…`
          : done
            ? `Your ${myRacers.length > 1 ? 'racers are' : 'racer is'} ${out ? 'out' : 'home'} — ${playerName(view, phase.active)}'s turn`
            : `${playerName(view, phase.active)}'s turn`}
      </Waiting>
    </ActionBar>
  );
}
