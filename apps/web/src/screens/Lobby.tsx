import { MAX_PLAYERS } from '@mr/engine';
import { useState } from 'react';
import { ActionBar, PlayerToken, Waiting } from '../components/bits';
import { forgetCredentials } from '../lib/identity';
import { playerName } from '../lib/present';
import { legalOf, useRoomContext } from '../lib/roomContext';
import { navigate, roomLink } from '../lib/router';

export function LobbyScreen() {
  const { code, view, message, canAct, send } = useRoomContext();
  const [shared, setShared] = useState<string | null>(null);

  const host = view.players[0];
  const isHost = host?.id === view.you;
  const canStart = legalOf(message, 'lobby/start').length > 0;
  const seatsLeft = MAX_PLAYERS - view.players.length;

  const share = async (): Promise<void> => {
    const url = roomLink(code);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Mythical Runner', text: `Join my race! Room ${code}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared('Link copied');
    } catch {
      // A cancelled share sheet throws; that is not an error worth showing.
    }
  };

  const leave = (): void => {
    send({ t: 'lobby/leave' });
    forgetCredentials(code);
    navigate('/');
  };

  return (
    <>
      <main className="page">
        <section className="card stack" style={{ textAlign: 'center' }}>
          <p className="section-title">Room code</p>
          <p className="num" style={{ fontSize: '3rem', fontWeight: 850, letterSpacing: '0.18em' }}>
            {code}
          </p>
          <button type="button" className="btn btn-block" onClick={share}>
            {shared ?? 'Invite friends'}
          </button>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            {message.turnSeconds > 0 ? `${message.turnSeconds}s per turn` : 'No turn timer'} · 2–6 players
          </p>
        </section>

        <section className="card" aria-labelledby="players-heading">
          <div className="spread" style={{ marginBottom: 4 }}>
            <h2 id="players-heading" className="section-title">
              Players
            </h2>
            <span className="muted num" style={{ fontSize: '0.85rem' }}>
              {view.players.length}/{MAX_PLAYERS}
            </span>
          </div>
          {view.players.map((p, i) => (
            <div key={p.id} className={`player-row${p.connected ? '' : ' offline'}`}>
              <PlayerToken view={view} pid={p.id} />
              <span className="name">{p.name}</span>
              {i === 0 && <span className="tag tag-gold">host</span>}
              {p.id === view.you && <span className="tag">you</span>}
              {!p.connected && <span className="tag">away</span>}
            </div>
          ))}
          {seatsLeft > 0 && (
            <p className="muted" style={{ fontSize: '0.85rem', paddingTop: 8 }}>
              {seatsLeft} seat{seatsLeft === 1 ? '' : 's'} open
            </p>
          )}
        </section>

        <button type="button" className="btn btn-ghost btn-block" onClick={leave}>
          Leave room
        </button>
      </main>

      <ActionBar>
        {isHost ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              disabled={!canStart || !canAct}
              onClick={() => send({ t: 'lobby/start' })}
            >
              Start game
            </button>
            {!canStart && <p className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>Waiting for at least one more player</p>}
          </>
        ) : (
          <Waiting>Waiting for {host ? playerName(view, host.id) : 'the host'} to start</Waiting>
        )}
      </ActionBar>
    </>
  );
}
