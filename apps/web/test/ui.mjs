/**
 * UI end-to-end test — the phase 4 gate: "playable on a phone".
 *
 * Plays a complete game through the real web app as three people on phone-sized screens,
 * one in dark mode. Every action is a tap on a rendered button: no API calls, no state
 * injection. Screenshots each phase so the result can be looked at, not just asserted on.
 *
 *   npm run start                      # build the app and serve app + API on :8787
 *   npm run test:ui -w @mr/web         # in another terminal
 *
 * Uses an already-installed Chrome rather than downloading a browser. Override with
 * CHROME_PATH=/path/to/chrome. Point at another server with BASE=https://….
 *
 * Checks: the game reaches game over for every player; all clients agree on the final
 * scores; no page errors, no console errors, and no horizontal overflow on any screen.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome or Chromium found. Set CHROME_PATH.');
  process.exit(2);
}

try {
  const res = await fetch(`${BASE}/api/health`);
  if (!res.ok) throw new Error(`status ${res.status}`);
} catch (err) {
  console.error(`Server not reachable at ${BASE} (${err.message}). Run: npm run start`);
  process.exit(2);
}

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
/** Taps can race: another player's tap may advance everyone and remove this button. */
const TAP = { timeout: 1500 };
const STALL_MS = 45_000;
const GAME_TIMEOUT_MS = 8 * 60_000;

const browser = await chromium.launch({ executablePath, headless: true });
const problems = [];
let shotCount = 0;

async function newPlayer(name, colorScheme) {
  const context = await browser.newContext({ ...PHONE, colorScheme });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`[${name}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${name}] console error: ${m.text()}`);
  });
  return { name, page, colorScheme, done: false };
}

async function screenshot(player, label, fullPage = false) {
  const file = `${String(++shotCount).padStart(2, '0')}-${player.name}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`;
  await player.page.screenshot({ path: join(SHOTS, file), fullPage });
}

async function checkOverflow(player, where) {
  const over = await player.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) problems.push(`[${player.name}] ${over}px horizontal overflow on "${where}"`);
}

// --- A host creates a room; two friends join from the link -------------------

const host = await newPlayer('Ada', 'light');
await host.page.goto(BASE);
await host.page.getByLabel('Your name').fill('Ada');
await screenshot(host, 'home');
await host.page.getByRole('button', { name: 'Off' }).click(); // no turn clock: deterministic
await host.page.getByRole('button', { name: 'Create room' }).click();
await host.page.waitForURL(/\/r\/[A-Z0-9]{4}$/);
const code = host.page.url().slice(-4);
console.log(`Room ${code}`);

const guests = [];
for (const [name, scheme] of [
  ['Bo', 'dark'],
  ['Cy', 'light'],
]) {
  const guest = await newPlayer(name, scheme);
  await guest.page.goto(`${BASE}/r/${code}`);
  // Typing must not join by itself: that bug seated people after their first keystroke.
  await guest.page.getByLabel('Your name').pressSequentially(name, { delay: 30 });
  await guest.page.waitForTimeout(300);
  if (await guest.page.locator('.topbar').count()) {
    problems.push(`[${name}] joined the room while still typing a name`);
  }
  await guest.page.getByRole('button', { name: 'Take a seat' }).click();
  guests.push(guest);
}
const players = [host, ...guests];

await host.page.getByText('Cy', { exact: true }).waitFor();
await screenshot(host, 'lobby');
await screenshot(guests[0], 'lobby');
await checkOverflow(host, 'lobby');

await host.page.getByRole('button', { name: 'Start game' }).click();

// --- Everyone taps whatever the UI offers them, until the game ends ----------

const screenshotted = new Set();
const phaseKey = (label) =>
  label.replace(/pick \d+ of \d+/, 'pick').replace(/Race \d of 4/, 'Race').replace(/ results/, '-results');
let decisionScreenshotted = false;
let lastProgress = Date.now();

async function takeTurn(player) {
  const { page } = player;
  if ((await page.locator('.winner').count()) > 0) {
    player.done = true;
    return;
  }

  // One screenshot per phase, in each theme.
  const label = (await page.locator('.phase-label').textContent().catch(() => '')) ?? '';
  const key = `${phaseKey(label)}|${player.colorScheme}`;
  if (label && !screenshotted.has(key) && player !== guests[1]) {
    screenshotted.add(key);
    await page.waitForTimeout(400);
    await screenshot(player, `${phaseKey(label)}-${player.colorScheme}`, /Race|results/.test(label));
    await checkOverflow(player, label);
  }

  const bar = page.locator('.actionbar');

  const options = bar.locator('.options button:enabled');
  const optionCount = await options.count();
  if (optionCount > 0) {
    if (!decisionScreenshotted) {
      decisionScreenshotted = true;
      await screenshot(player, 'decision');
    }
    await options.nth(Math.floor(Math.random() * optionCount)).click(TAP).catch(() => {});
    lastProgress = Date.now();
    return;
  }

  // Never "Play again": it leaves the finished game.
  const button = bar.locator('button:enabled', { hasNotText: 'Play again' });
  if ((await button.count()) > 0) {
    await button.first().click(TAP).catch(() => {});
    lastProgress = Date.now();
    return;
  }

  if ((await bar.getByText('Tap a racer to choose').count()) > 0) {
    const cards = page.locator('.racer-card:enabled');
    const cardCount = await cards.count();
    if (cardCount > 0) {
      await cards.nth(Math.floor(Math.random() * cardCount)).click(TAP).catch(() => {});
      lastProgress = Date.now();
    }
  }
}

const gameDeadline = Date.now() + GAME_TIMEOUT_MS;
try {
  while (!players.every((p) => p.done)) {
    if (Date.now() > gameDeadline) throw new Error('the game did not finish in time');
    if (Date.now() - lastProgress > STALL_MS) {
      for (const p of players) await screenshot(p, 'STALLED', true);
      throw new Error(`nobody could act for ${STALL_MS / 1000}s`);
    }
    for (const p of players) await takeTurn(p);
    await host.page.waitForTimeout(60);
  }
} catch (err) {
  problems.push(err.message);
}

// --- Results ------------------------------------------------------------------

if (players.every((p) => p.done)) {
  await screenshot(host, 'game-over');
  await screenshot(guests[0], 'game-over');
  await checkOverflow(host, 'game over');

  const scores = await Promise.all(
    players.map((p) => p.page.locator('.player-row .big-points').allTextContents()),
  );
  const agreed = new Set(scores.map((s) => s.join(','))).size === 1;
  if (!agreed) problems.push(`clients disagree on final scores: ${JSON.stringify(scores)}`);
  const headline = await host.page.locator('.winner h1').textContent();
  console.log(`Game over — host sees "${headline}", scores ${scores[0].join(' / ')}`);
}

await browser.close();

console.log(`${readdirSync(SHOTS).length} screenshots in ${SHOTS}`);
if (problems.length > 0) {
  console.log(`\nFAIL\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('PASS — full game played through the UI; no errors, no overflow, clients agree.');
