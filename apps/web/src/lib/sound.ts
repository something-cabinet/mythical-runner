/**
 * Sound effects, synthesised with Web Audio rather than loaded from files: nothing to
 * download, nothing to license, and every cue is a few lines to tweak.
 *
 * Browsers refuse to start audio before the page has been interacted with, so the context
 * is created on the first pointer or key press. Anything played before then is dropped,
 * which is the right thing for sounds that only mean something in the moment.
 */

export type Sound =
  | 'hop'
  | 'throw'
  | 'trip'
  | 'eliminated'
  | 'ability'
  | 'finish'
  | 'finishMine'
  | 'yourTurn'
  | 'decision'
  | 'raceStart'
  | 'pick'
  | 'join'
  | 'win'
  | 'gameOver';

const MUTE_KEY = 'mr:muted';
const MASTER_GAIN = 0.45;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = readMuted();
const listeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // Storage unavailable; the setting just won't survive a reload.
  }
  if (master) master.gain.value = value ? 0 : MASTER_GAIN;
  for (const l of listeners) l();
}

/** For `useSyncExternalStore`. */
export function subscribeMuted(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function unlock(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

interface ToneOpts {
  readonly freq: number;
  readonly dur: number;
  readonly at?: number;
  readonly type?: OscillatorType;
  readonly gain?: number;
  /** Glide to this frequency over the note. */
  readonly to?: number;
}

function tone(ac: AudioContext, out: AudioNode, o: ToneOpts): void {
  const t = ac.currentTime + (o.at ?? 0);
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
  const peak = o.gain ?? 0.3;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(env).connect(out);
  osc.start(t);
  osc.stop(t + o.dur + 0.02);
}

interface NoiseOpts {
  readonly dur: number;
  readonly at?: number;
  readonly gain?: number;
  readonly filter?: BiquadFilterType;
  readonly freq?: number;
}

function noise(ac: AudioContext, out: AudioNode, o: NoiseOpts): void {
  if (!noiseBuffer) return;
  const t = ac.currentTime + (o.at ?? 0);
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ac.createBiquadFilter();
  filter.type = o.filter ?? 'bandpass';
  filter.frequency.value = o.freq ?? 2500;
  const env = ac.createGain();
  env.gain.setValueAtTime(o.gain ?? 0.3, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(filter).connect(env).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + o.dur + 0.02);
}

/** A little pitch wobble so repeated cues (hops, dice) don't sound mechanical. */
function wobble(): number {
  return 0.94 + Math.random() * 0.12;
}

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;

export function play(sound: Sound): void {
  if (muted || !ctx || !master || ctx.state !== 'running') return;
  const ac = ctx;
  const out = master;
  switch (sound) {
    case 'hop': {
      const w = wobble();
      tone(ac, out, { freq: 480 * w, to: 720 * w, dur: 0.07, type: 'triangle', gain: 0.16 });
      break;
    }
    case 'throw': {
      // Rattle while the die tumbles, then a clack as it lands (see ROLL_TUMBLE_MS).
      for (let i = 0; i < 6; i++) {
        noise(ac, out, { at: i * 0.085 + Math.random() * 0.03, dur: 0.035, gain: 0.22 - i * 0.02, freq: 3200 });
      }
      noise(ac, out, { at: 0.6, dur: 0.08, gain: 0.35, filter: 'lowpass', freq: 1400 });
      tone(ac, out, { at: 0.6, freq: 190 * wobble(), dur: 0.06, type: 'square', gain: 0.08 });
      break;
    }
    case 'trip':
      tone(ac, out, { freq: 420, to: 110, dur: 0.32, type: 'sawtooth', gain: 0.12 });
      noise(ac, out, { at: 0.26, dur: 0.14, gain: 0.4, filter: 'lowpass', freq: 500 });
      break;
    case 'eliminated':
      tone(ac, out, { freq: 330, to: 70, dur: 0.7, type: 'sawtooth', gain: 0.13 });
      tone(ac, out, { freq: 220, to: 55, dur: 0.7, type: 'square', gain: 0.06 });
      break;
    case 'ability':
      tone(ac, out, { freq: 880, dur: 0.12, gain: 0.1 });
      tone(ac, out, { at: 0.06, freq: 1320, dur: 0.16, gain: 0.08 });
      tone(ac, out, { at: 0.12, freq: 1760, dur: 0.2, gain: 0.05 });
      break;
    case 'finish':
      [C5, E5, G5].forEach((f, i) => tone(ac, out, { at: i * 0.08, freq: f, dur: 0.22, type: 'triangle', gain: 0.18 }));
      break;
    case 'finishMine':
      [C5, E5, G5, C6].forEach((f, i) => tone(ac, out, { at: i * 0.09, freq: f, dur: 0.3, type: 'triangle', gain: 0.24 }));
      tone(ac, out, { at: 0.36, freq: C6 * 1.5, dur: 0.5, gain: 0.08 });
      break;
    case 'yourTurn':
      tone(ac, out, { freq: 660, dur: 0.18, gain: 0.2 });
      tone(ac, out, { at: 0.12, freq: 990, dur: 0.3, gain: 0.2 });
      break;
    case 'decision':
      [880, 1175, 880].forEach((f, i) => tone(ac, out, { at: i * 0.09, freq: f, dur: 0.14, type: 'triangle', gain: 0.14 }));
      break;
    case 'raceStart':
      // Three reds and a green.
      for (let i = 0; i < 3; i++) tone(ac, out, { at: i * 0.32, freq: 440, dur: 0.16, type: 'square', gain: 0.08 });
      tone(ac, out, { at: 0.96, freq: 880, dur: 0.45, type: 'square', gain: 0.1 });
      break;
    case 'pick':
      tone(ac, out, { freq: 700 * wobble(), to: 1050, dur: 0.12, type: 'triangle', gain: 0.18 });
      break;
    case 'join':
      tone(ac, out, { freq: 520, dur: 0.1, gain: 0.14 });
      tone(ac, out, { at: 0.08, freq: 780, dur: 0.14, gain: 0.14 });
      break;
    case 'win':
      [C5, E5, G5, C6, G5, C6].forEach((f, i) =>
        tone(ac, out, { at: i * 0.12, freq: f, dur: i === 5 ? 0.7 : 0.2, type: 'square', gain: 0.09 }),
      );
      break;
    case 'gameOver':
      [G5, E5, C5].forEach((f, i) => tone(ac, out, { at: i * 0.16, freq: f, dur: 0.35, type: 'triangle', gain: 0.18 }));
      break;
  }
}
