/**
 * End-to-end test against a running server — the phase 3 gate.
 *
 * The plan's gate is "two browsers play a full game". There is no browser client until
 * phase 4, so this drives real WebSocket clients over the exact protocol a browser will
 * use, against the real Worker and Durable Object running in workerd via `wrangler dev`.
 *
 *   npm run dev -w @mr/server        # in one terminal
 *   npm run e2e -w @mr/server        # in another
 *
 * Or point it elsewhere:  BASE=https://mythical-runner.example.workers.dev npm run e2e ...
 *
 * Deliberately plain JavaScript with no dependencies: Node 22's built-in WebSocket and
 * fetch are all it needs, and it imports nothing from the engine — it only knows what
 * a client knows.
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

let failures = 0;
let checks = 0;

function check(cond, label, detail) {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

const rand = (n) => Math.floor(Math.random() * n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token(len = 24) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => abc[rand(abc.length)]).join('');
}

function identity(name) {
  return { playerId: `p_${token(12)}`, secret: token(32), name };
}

async function createRoom(turnSeconds) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(turnSeconds === undefined ? {} : { turnSeconds }),
  });
  if (res.status !== 201) throw new Error(`create room failed: ${res.status}`);
  return (await res.json()).code;
}

/**
 * A client connection with a small amount of bookkeeping.
 *
 * Every raw frame is kept, so leak checks can inspect exactly what went over the wire
 * rather than a parsed-and-possibly-normalised copy.
 */
function connect(code, who) {
  const qs = new URLSearchParams({ playerId: who.playerId, secret: who.secret, name: who.name });
  const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws?${qs}`);

  const client = {
    who,
    ws,
    raw: [],
    errors: [],
    state: null,
    listeners: new Set(),
    closed: null,
    send(action) {
      ws.send(JSON.stringify({ t: 'action', action }));
    },
    sendRaw(text) {
      ws.send(text);
    },
    close() {
      ws.close(1000, 'bye');
    },
    /** Resolves with the first state (or error) satisfying `pred`, checking the latest first. */
    waitFor(pred, timeoutMs = 10000, label = 'condition') {
      return new Promise((resolve, reject) => {
        if (client.state && pred(client.state)) return resolve(client.state);
        const timer = setTimeout(() => {
          client.listeners.delete(fn);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        const fn = (msg) => {
          if (msg.t === 'state' && pred(msg)) {
            clearTimeout(timer);
            client.listeners.delete(fn);
            resolve(msg);
          }
        };
        client.listeners.add(fn);
      });
    },
  };

  client.closed = new Promise((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
  });

  ws.addEventListener('message', (e) => {
    const text = String(e.data);
    client.raw.push(text);
    const msg = JSON.parse(text);
    if (msg.t === 'state') client.state = msg;
    if (msg.t === 'error') client.errors.push(msg);
    for (const fn of [...client.listeners]) fn(msg);
  });

  client.opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });

  return client;
}

/**
 * Makes a client play by itself: on every state, take a random legal action.
 *
 * `lastStep` stops a bot firing twice at one state. After an illegal-action error the
 * server resends the current state at the same step, so that guard is cleared to let the
 * bot try again — otherwise a bot beaten to a shared action (`race/continue`) would stall.
 */
function autoplay(client, { idle = () => false } = {}) {
  let lastStep = -1;
  const act = (msg) => {
    if (msg.t === 'error') {
      lastStep = -1;
      return;
    }
    if (msg.t !== 'state' || idle()) return;
    if (msg.legal.length === 0 || msg.view.step === lastStep) return;
    lastStep = msg.view.step;
    client.send(msg.legal[rand(msg.legal.length)]);
  };
  client.listeners.add(act);
  if (client.state) act(client.state);
  return () => client.listeners.delete(act);
}

function scenario(name, fn) {
  return async () => {
    console.log(`\n${name}`);
    try {
      await fn();
    } catch (err) {
      failures++;
      console.log(`  FAIL  threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

const isGameOver = (m) => m.view.phase.t === 'gameOver';

// --- Scenarios --------------------------------------------------------------

const fullGame = scenario('Four clients play a complete game over WebSockets', async () => {
  const code = await createRoom(0); // no clock: this test is about the happy path
  const clients = ['Ada', 'Bo', 'Cy', 'Di'].map((n) => connect(code, identity(n)));
  await Promise.all(clients.map((c) => c.opened));

  const host = clients[0];
  await host.waitFor((m) => m.view.players.length === 4, 5000, 'all four seated');
  check(true, 'all four players seated');

  const hostLegal = host.state.legal.map((a) => a.t);
  const guestLegal = clients[1].state.legal.map((a) => a.t);
  check(hostLegal.includes('lobby/start'), 'the host is offered lobby/start');
  check(!guestLegal.includes('lobby/start'), 'a guest is not');

  const started = Date.now();
  host.send({ t: 'lobby/start' });
  const stops = clients.map((c) => autoplay(c));

  await Promise.all(clients.map((c) => c.waitFor(isGameOver, 120000, 'game over')));
  stops.forEach((s) => s());
  const elapsed = Date.now() - started;

  await sleep(300);
  const views = clients.map((c) => c.state.view);
  const steps = new Set(views.map((v) => v.step));
  check(steps.size === 1, 'every client ends on the same step', `steps ${[...steps]}`);

  const scoreSig = (v) => JSON.stringify(v.scores);
  check(new Set(views.map(scoreSig)).size === 1, 'every client agrees on the final scores');
  check(views[0].phase.winners.length >= 1, 'at least one winner declared');

  const totalFrames = clients.reduce((n, c) => n + c.raw.length, 0);
  console.log(`        ${views[0].step} steps, ${totalFrames} frames, ${elapsed} ms`);

  // Leak checks against the raw wire bytes, not parsed objects.
  const allRaw = clients.flatMap((c) => c.raw);
  check(!allRaw.some((r) => r.includes('"seed"')), 'the seed never went over the wire');
  check(!allRaw.some((r) => r.includes('"queue"')), 'engine job queue never went over the wire');
  check(!allRaw.some((r) => r.includes('"resume"')), 'suspended-power continuations never went over the wire');

  const illegal = clients.flatMap((c) => c.errors).filter((e) => e.code !== 'illegal_action');
  check(illegal.length === 0, 'no errors other than benign stale-click rejections', JSON.stringify(illegal[0]));

  clients.forEach((c) => c.close());
});

const secrecy = scenario('Commits stay secret until everyone has chosen', async () => {
  const code = await createRoom(0);
  const [a, b] = [connect(code, identity('A')), connect(code, identity('B'))];
  await Promise.all([a.opened, b.opened]);
  await a.waitFor((m) => m.view.players.length === 2);

  a.send({ t: 'lobby/start' });
  // Play both through the roll-off and draft, then stop as soon as commits open.
  const stopA = autoplay(a, { idle: () => a.state?.view.phase.t === 'commit' });
  const stopB = autoplay(b, { idle: () => b.state?.view.phase.t === 'commit' });
  await Promise.all([a, b].map((c) => c.waitFor((m) => m.view.phase.t === 'commit', 20000, 'commit phase')));
  stopA();
  stopB();

  const pick = a.state.legal.find((x) => x.t === 'race/commit');
  a.send(pick);
  const bView = await b.waitFor((m) => m.view.phase.committedBy?.length === 1, 5000, 'A committed');

  check(bView.view.phase.committedBy.includes(a.who.playerId), "B can see that A has committed");
  check(bView.view.phase.yourCommit === null, "B's view carries only B's own (empty) commit");

  // A's racer legitimately appears in `hands`: drafted teams are public, because the draft
  // happens face-up. What must not happen is anything revealing WHICH of those four A
  // chose. So the check is against the frame with the public hands removed.
  const { hands, ...viewWithoutHands } = bView.view;
  check(hands[a.who.playerId].includes(pick.racerId), "A's racer is in A's public drafted hand, as expected");
  const outsideHands = JSON.stringify({ ...bView, view: viewWithoutHands });
  check(
    !outsideHands.includes(`"${pick.racerId}"`),
    "nothing outside the public hands reveals which racer A chose",
    pick.racerId,
  );
  check(!bView.view.used[a.who.playerId].includes(pick.racerId), "A's choice is not yet marked used");
  check(bView.events.length === 0, 'committing emits no event another player could read');

  const aView = await a.waitFor((m) => m.view.phase.yourCommit !== null, 5000);
  check(aView.view.phase.yourCommit === pick.racerId, 'A sees their own commit');

  [a, b].forEach((c) => c.close());
});

const auth = scenario('Credentials, room existence and seat limits are enforced', async () => {
  const code = await createRoom(0);
  const owner = identity('Owner');
  const first = connect(code, owner);
  await first.opened;
  await first.waitFor((m) => m.view.players.length === 1);

  const thief = connect(code, { ...owner, secret: token(32), name: 'Thief' });
  const thiefClose = await thief.closed;
  check(thiefClose.code === 4001, 'a wrong secret for an existing seat is refused (4001)', `got ${thiefClose.code}`);
  check(thief.errors[0]?.code === 'bad_credentials', 'and told why before closing');

  const missing = connect('ZZZZ', identity('Lost'));
  check((await missing.closed).code === 4004, 'a room that does not exist is refused (4004)');

  const malformed = connect(code, { playerId: 'x', secret: 'short', name: 'Bad' });
  check((await malformed.closed).code === 4000, 'malformed credentials are refused (4000)');

  const guests = Array.from({ length: 5 }, (_, i) => connect(code, identity(`G${i}`)));
  await Promise.all(guests.map((g) => g.opened));
  await first.waitFor((m) => m.view.players.length === 6, 5000, 'room full');
  const seventh = connect(code, identity('Seventh'));
  check((await seventh.closed).code === 4003, 'a seventh player is refused (4003)');

  first.send({ t: 'lobby/start' });
  await first.waitFor((m) => m.view.phase.t !== 'lobby', 5000, 'game started');
  const latecomer = connect(code, identity('Late'));
  check((await latecomer.closed).code === 4003, 'a new player cannot join a game in progress (4003)');

  [first, ...guests].forEach((c) => c.close());
});

const impersonation = scenario('A client cannot act as someone else or as the clock', async () => {
  const code = await createRoom(0);
  const [a, b] = [connect(code, identity('A')), connect(code, identity('B'))];
  await Promise.all([a.opened, b.opened]);
  await a.waitFor((m) => m.view.players.length === 2);

  // B tries to start the game while claiming to be the host.
  b.send({ t: 'lobby/start', by: a.who.playerId });
  await b.waitFor(() => b.errors.length > 0, 3000, 'rejection').catch(() => {});
  await sleep(200);
  check(b.errors.some((e) => e.code === 'illegal_action'), "a client-supplied 'by' is ignored: B is not the host");
  check(a.state.view.phase.t === 'lobby', 'the game did not start');

  const before = b.errors.length;
  b.send({ t: 'system/timeout', at: Date.now() });
  await sleep(300);
  check(b.errors.slice(before).some((e) => e.code === 'bad_request'), 'clients may not send system/timeout');

  const beforeJoin = b.errors.length;
  b.send({ t: 'lobby/join', name: 'dupe' });
  await sleep(300);
  check(b.errors.slice(beforeJoin).some((e) => e.code === 'bad_request'), 'clients may not send lobby/join');

  const beforeJunk = b.errors.length;
  b.sendRaw('{not json');
  await sleep(300);
  check(b.errors.slice(beforeJunk).some((e) => e.code === 'bad_request'), 'malformed JSON is rejected, not fatal');
  check(b.ws.readyState === WebSocket.OPEN, 'and the socket survives it');

  [a, b].forEach((c) => c.close());
});

const reconnect = scenario('A player can drop mid-game and reconnect to the same seat', async () => {
  const code = await createRoom(0);
  const aId = identity('A');
  const [a, b] = [connect(code, aId), connect(code, identity('B'))];
  await Promise.all([a.opened, b.opened]);
  await a.waitFor((m) => m.view.players.length === 2);
  a.send({ t: 'lobby/start' });

  const stopA = autoplay(a);
  const stopB = autoplay(b);
  await b.waitFor((m) => m.view.phase.t === 'racing', 30000, 'a race to start');
  stopA();
  stopB();

  a.close();
  const seenGone = await b.waitFor(
    (m) => m.view.players.find((p) => p.id === aId.playerId)?.connected === false,
    5000,
    'A to show as disconnected',
  );
  check(!!seenGone, 'the other player sees A disconnect');
  const stepWhileAway = seenGone.view.step;

  const a2 = connect(code, aId);
  await a2.opened;
  const back = await a2.waitFor((m) => m.view.players.length === 2, 5000, 'A to resync');
  check(back.view.you === aId.playerId, 'A is back in their own seat');
  check(back.view.step > stepWhileAway, 'A resumes the live game, not a fresh one');
  check(back.view.phase.t !== 'lobby', 'the game is still in progress');

  await b.waitFor((m) => m.view.players.find((p) => p.id === aId.playerId)?.connected === true, 5000);
  check(true, 'the other player sees A reconnect');

  // Two tabs for one player: closing one must not mark them disconnected.
  const a3 = connect(code, aId);
  await a3.opened;
  await sleep(300);
  a3.close();
  await sleep(500);
  const stillThere = b.state.view.players.find((p) => p.id === aId.playerId)?.connected;
  check(stillThere === true, 'closing a second tab does not disconnect the player');

  [a2, b].forEach((c) => c.close());
});

const clock = scenario('The turn clock auto-plays for an idle player', async () => {
  const code = await createRoom(15); // the minimum
  const [a, b] = [connect(code, identity('A')), connect(code, identity('Idle'))];
  await Promise.all([a.opened, b.opened]);
  await a.waitFor((m) => m.view.players.length === 2);

  let bIdle = false;
  a.send({ t: 'lobby/start' });
  const stopA = autoplay(a);
  const stopB = autoplay(b, { idle: () => bIdle });

  await a.waitFor((m) => m.view.phase.t === 'racing', 30000, 'a race to start');
  check(typeof a.state.view.deadline === 'number', 'a deadline is published for the countdown');

  // B stops responding. A keeps playing. Wait until it is B's move, then see whether the
  // server moves the game on without them.
  bIdle = true;
  const waiting = await a.waitFor(
    (m) => m.view.phase.t === 'racing' && m.view.phase.active === b.who.playerId && m.view.pending === null,
    30000,
    "B's turn",
  );
  const frozenStep = waiting.view.step;
  const t0 = Date.now();

  const advanced = await a.waitFor(
    (m) => m.view.step > frozenStep && m.events.some((e) => e.t === 'dice/rolled' || e.t === 'racer/stoodUp'),
    25000,
    'the clock to auto-roll for B',
  );
  const waited = Date.now() - t0;
  check(!!advanced, 'the server rolled for the idle player');
  check(waited >= 10000 && waited <= 22000, 'after roughly the configured 15 seconds', `${waited} ms`);

  stopA();
  stopB();
  [a, b].forEach((c) => c.close());
});

// --- Run --------------------------------------------------------------------

const onlyFast = process.argv.includes('--fast');

try {
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) throw new Error(`status ${health.status}`);
} catch (err) {
  console.error(`Server not reachable at ${BASE} (${err.message}). Start it with: npm run dev -w @mr/server`);
  process.exit(2);
}

console.log(`Testing ${BASE}`);
for (const run of [fullGame, secrecy, auth, impersonation, reconnect, ...(onlyFast ? [] : [clock])]) {
  await run();
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
