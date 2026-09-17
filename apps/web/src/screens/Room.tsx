import type { ClientAction, RoomInfoResponse } from '@mr/engine';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Countdown, Toast } from '../components/bits';
import { fetchRoomInfo } from '../lib/api';
import {
  forgetCredentials,
  getOrCreateCredentials,
  loadCredentials,
  loadName,
  saveName,
  type Credentials,
} from '../lib/identity';
import { RoomClient } from '../lib/roomClient';
import { RoomContext, useRoomContext, type RoomContextValue } from '../lib/roomContext';
import { navigate, roomLink } from '../lib/router';
import { useBoardPositions } from '../lib/useBoardPositions';
import { useEventLog } from '../lib/useEventLog';
import { CommitScreen } from './Commit';
import { DraftScreen } from './Draft';
import { GameOverScreen } from './GameOver';
import { LobbyScreen } from './Lobby';
import { RaceScreen } from './Race';
import { ResultsScreen } from './Results';

/**
 * A room, from "does it exist" to the game itself.
 *
 * Before opening a socket it asks the HTTP API whether the room exists and can be joined,
 * because a browser cannot read why a WebSocket upgrade failed — only that it did.
 */
export function Room({ code }: { code: string }) {
  const [info, setInfo] = useState<RoomInfoResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(() => loadCredentials(code));
  const [name, setName] = useState(loadName);
  // Captured once. Auto-join must key off a name saved *before* arriving — never the live
  // form field, or typing the first letter of a name would join the room as "B".
  const [hadSavedName] = useState(() => loadName().trim() !== '');

  useEffect(() => {
    let cancelled = false;
    fetchRoomInfo(code)
      .then((i) => !cancelled && setInfo(i))
      .catch((err: unknown) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Someone who has sat in this room before, or already has a name, goes straight in.
  const readyToJoin = credentials !== null || (info?.joinable === true && hadSavedName);
  useEffect(() => {
    if (readyToJoin && info?.exists && !credentials) setCredentials(getOrCreateCredentials(code));
  }, [readyToJoin, info, credentials, code]);

  if (loadError) return <Message title="Can't reach the server" body={loadError} />;
  if (!info) return <Message title={`Finding room ${code}…`} />;
  if (!info.exists) {
    return <Message title={`There's no room ${code}`} body="It may have expired, or the code has a typo." />;
  }
  if (!credentials && !info.joinable) {
    return (
      <Message
        title={info.phase === 'lobby' ? 'That room is full' : 'That game has already started'}
        body="Ask the host to start a new room."
      />
    );
  }

  // The effect above is about to issue credentials; don't flash the name form for a frame.
  if (!credentials && readyToJoin) return <Message title={`Joining ${code}…`} />;

  if (!credentials) {
    const submit = (e: FormEvent): void => {
      e.preventDefault();
      saveName(name);
      setCredentials(getOrCreateCredentials(code));
    };
    return (
      <main className="page">
        <header className="hero">
          <h1>
            Join <span>{code}</span>
          </h1>
          <p>
            {info.playerCount} of {info.maxPlayers} seats taken
          </p>
        </header>
        <form className="card stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="join-name">Your name</label>
            <input
              id="join-name"
              className="input"
              value={name}
              maxLength={24}
              autoFocus
              autoComplete="nickname"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={name.trim() === ''}>
            Take a seat
          </button>
        </form>
      </main>
    );
  }

  return <Connected code={code} credentials={credentials} name={name.trim()} />;
}

function Connected({ code, credentials, name }: { code: string; credentials: Credentials; name: string }) {
  // Deliberately not keyed on `name`: it only matters on first join, and a rename must not
  // tear down a live socket mid-game.
  const [client] = useState(() => new RoomClient(code, credentials, name));

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const clearNotice = useCallback(() => setDismissed(snapshot.notice), [snapshot.notice]);

  const send = useCallback((action: ClientAction) => client.send(action), [client]);

  // Both subscribe here, above the phase switch, so neither misses the events carried by
  // the message that changes screens.
  const log = useEventLog(client);
  const board = useBoardPositions(client, snapshot.message);
  const holding = useFinishHold(snapshot.message?.view.phase.t, board.animating);

  if (snapshot.fatal) {
    const f = snapshot.fatal;
    const rejoin = f.code === 'bad_credentials';
    return (
      <Message
        title={
          f.code === 'room_not_found'
            ? 'This room has closed'
            : f.code === 'bad_credentials'
              ? "That seat isn't yours on this device"
              : f.code === 'game_in_progress'
                ? 'That game has already started'
                : f.code === 'room_full'
                  ? 'That room is full'
                  : "Couldn't join"
        }
        body={f.message}
        action={
          rejoin
            ? {
                label: 'Join as a new player',
                run: () => {
                  forgetCredentials(code);
                  location.reload();
                },
              }
            : undefined
        }
      />
    );
  }

  const message = snapshot.message;
  if (!message) {
    return <Message title="Connecting…" body={snapshot.status === 'reconnecting' ? 'Trying again.' : undefined} />;
  }

  const view = message.view;
  const value: RoomContextValue = {
    code,
    client,
    snapshot,
    message,
    view,
    canAct: !snapshot.awaiting && snapshot.status === 'open',
    send,
    log,
    board,
  };

  const wide = view.phase.t === 'racing' || view.phase.t === 'scored';
  const showRace = view.phase.t === 'racing' || (view.phase.t === 'scored' && holding);

  return (
    <RoomContext.Provider value={value}>
      <TopBar wide={wide} />
      {view.phase.t === 'lobby' && <LobbyScreen />}
      {(view.phase.t === 'draftRoll' || view.phase.t === 'draft') && <DraftScreen />}
      {view.phase.t === 'commit' && <CommitScreen />}
      {showRace && <RaceScreen />}
      {view.phase.t === 'scored' && !holding && <ResultsScreen />}
      {view.phase.t === 'gameOver' && <GameOverScreen />}
      <Toast message={snapshot.notice !== dismissed ? snapshot.notice : null} onDone={clearNotice} />
    </RoomContext.Provider>
  );
}

/** How long the finished race stays on screen after its last move has played. */
const FINISH_HOLD_MS = 1600;

/**
 * Keeps the race on screen briefly after it ends.
 *
 * The move that decides a race arrives in the same message that ends it. Switching straight
 * to the results would mean nobody ever sees the winner cross the line. So when the phase
 * goes from racing to scored, hold until the board has finished animating, then a beat
 * longer.
 */
function useFinishHold(phase: string | undefined, animating: boolean): boolean {
  const [holding, setHolding] = useState(false);
  const previous = useRef(phase);

  useEffect(() => {
    if (previous.current === 'racing' && phase === 'scored') setHolding(true);
    if (phase !== 'scored') setHolding(false);
    previous.current = phase;
  }, [phase]);

  useEffect(() => {
    if (!holding || animating) return;
    const id = setTimeout(() => setHolding(false), FINISH_HOLD_MS);
    return () => clearTimeout(id);
  }, [holding, animating]);

  return holding;
}

function TopBar({ wide }: { wide: boolean }) {
  const { code, view, snapshot, message } = useRoomContext();
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(roomLink(code));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the code is visible anyway.
    }
  };

  const phase = view.phase;
  const label =
    phase.t === 'lobby'
      ? 'Lobby'
      : phase.t === 'draftRoll'
        ? 'Draft · roll for order'
        : phase.t === 'draft'
          ? `Draft · pick ${Math.min(phase.pick + 1, phase.order.length * 4)} of ${phase.order.length * 4}`
          : phase.t === 'commit'
            ? `Race ${phase.raceNo} of 4 · choose`
            : phase.t === 'racing'
              ? `Race ${phase.raceNo} of 4 · ${phase.raceNo % 2 ? 'Mild Mile' : 'Wild Wilds'}`
              : phase.t === 'scored'
                ? `Race ${phase.raceNo} results`
                : 'Game over';

  const statusText = snapshot.status === 'open' ? 'Connected' : 'Reconnecting';

  return (
    <header className="topbar">
      <div className={`topbar-inner${wide ? ' topbar-inner-wide' : ''}`}>
        <button type="button" className="code-chip" onClick={copy} aria-label={`Room ${code}. Copy invite link.`}>
          {copied ? 'COPIED' : code}
        </button>
        <span className="phase-label">{label}</span>
        {message.turnSeconds > 0 && <Countdown deadline={view.deadline} />}
        <span className="conn-dot" data-status={snapshot.status} role="img" aria-label={statusText} title={statusText} />
      </div>
    </header>
  );
}

function Message({
  title,
  body,
  action,
}: {
  title: string;
  body?: string | undefined;
  action?: { label: string; run: () => void } | undefined;
}) {
  return (
    <main className="page">
      <div className="hero">
        <h1 style={{ fontSize: '1.7rem' }}>{title}</h1>
        {body && <p>{body}</p>}
      </div>
      {action && (
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={action.run}>
          {action.label}
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-block" onClick={() => navigate('/')}>
        Back to home
      </button>
    </main>
  );
}
