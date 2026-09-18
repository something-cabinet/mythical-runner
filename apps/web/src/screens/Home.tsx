import { useState, type FormEvent } from 'react';
import { createRoom, normalizeCode } from '../lib/api';
import { loadName, saveName } from '../lib/identity';
import { navigate } from '../lib/router';

const TIMERS = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
  { value: 120, label: '2m' },
] as const;

export function Home() {
  const [name, setName] = useState(loadName);
  const [turnSeconds, setTurnSeconds] = useState<number>(60);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      saveName(name);
      const newCode = await createRoom(turnSeconds);
      navigate(`/r/${newCode}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a room.');
      setBusy(false);
    }
  };

  const join = (e: FormEvent): void => {
    e.preventDefault();
    const normalized = normalizeCode(code);
    if (!normalized) {
      setError('Room codes are 4 letters and numbers.');
      return;
    }
    saveName(name);
    navigate(`/r/${normalized}`);
  };

  return (
    <main className="page">
      <header className="hero">
        <h1>
          Mythical <span>Runner</span>
        </h1>
        <p>Draft racers with rule-breaking powers. Race four times. Most points wins.</p>
      </header>

      <div className="card stack">
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            className="input"
            value={name}
            maxLength={24}
            autoComplete="nickname"
            placeholder="What should the table call you?"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <section className="card card-stage stack" aria-labelledby="create-heading">
        <h2 id="create-heading" className="section-title">
          Start a new game
        </h2>
        <div className="field">
          <label id="timer-label">Turn timer</label>
          <div className="segmented" role="group" aria-labelledby="timer-label">
            {TIMERS.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={turnSeconds === t.value}
                onClick={() => setTurnSeconds(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </section>

      <div className="divider">or</div>

      <form className="card stack" onSubmit={join} aria-labelledby="join-heading">
        <h2 id="join-heading" className="section-title">
          Join a friend
        </h2>
        <div className="row">
          <input
            aria-label="Room code"
            className="input input-code"
            value={code}
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="CODE"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="btn" disabled={code.trim().length !== 4}>
            Join
          </button>
        </div>
      </form>

      {error && (
        <p className="banner banner-warn" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
