// Synthesised sound effects: no audio files to download, under 30 ms from tap to sound.
import { settings } from './settings';

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let nbuf: AudioBuffer | null = null;

export function ensureAudio(): void {
  if (!ac) {
    try {
      ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      master = ac.createGain();
      master.connect(ac.destination);
    } catch {
      ac = null;
    }
  }
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
  if (master) master.gain.value = settings.sound ? settings.vol : 0;
}

function tone(f: number, d: number, type: OscillatorType = 'sine', v = 0.2, t = 0, slide?: number) {
  if (!ac || !master || !settings.sound) return;
  const o = ac.createOscillator(), g = ac.createGain(), st = ac.currentTime + t;
  o.type = type;
  o.frequency.setValueAtTime(f, st);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, st + d);
  g.gain.setValueAtTime(0.0001, st);
  g.gain.exponentialRampToValueAtTime(v, st + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, st + d);
  o.connect(g); g.connect(master); o.start(st); o.stop(st + d + 0.03);
}

function noise(d: number, v = 0.2, freq = 2000, q = 1, t = 0, ftype: BiquadFilterType = 'bandpass') {
  if (!ac || !master || !settings.sound) return;
  if (!nbuf) {
    nbuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const ch = nbuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), st = ac.currentTime + t;
  src.buffer = nbuf; f.type = ftype; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(0.0001, st);
  g.gain.exponentialRampToValueAtTime(v, st + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, st + d);
  src.connect(f); f.connect(g); g.connect(master); src.start(st, Math.random() * 0.5); src.stop(st + d + 0.03);
}

const SFX = {
  tap() { tone(1500, 0.03, 'triangle', 0.05); },
  knock() { tone(150, 0.08, 'sine', 0.35); noise(0.03, 0.12, 1500, 1); tone(140, 0.08, 'sine', 0.25, 0.13); noise(0.03, 0.1, 1500, 1, 0.13); },
  flourish() { [0, 0.08, 0.16, 0.22, 0.28].forEach((t, i) => { tone(170 + i * 45, 0.13, 'sine', 0.3, t, 110 + i * 30); noise(0.03, 0.1, 3000, 2, t); }); tone(660, 0.5, 'triangle', 0.1, 0.36); },
  clink(n = 1) { for (let i = 0; i < n; i++) { const t = i * 0.065; tone(2600 + Math.random() * 400, 0.09, 'triangle', 0.12, t); tone(3900 + Math.random() * 300, 0.06, 'sine', 0.06, t + 0.006); } },
  flick(t = 0) { noise(0.05, 0.2, 3200, 1.4, t); },
  land(t = 0) { noise(0.035, 0.13, 900, 0.9, t); tone(210, 0.04, 'sine', 0.07, t); },
  shuffle() { for (let i = 0; i < 16; i++) noise(0.04, 0.15, 2400 + Math.random() * 1500, 1.2, i * 0.06); noise(0.28, 0.2, 1800, 0.7, 1.0); },
  chime() { tone(880, 0.22, 'sine', 0.16); tone(1320, 0.32, 'sine', 0.14, 0.12); },
  tick() { tone(1900, 0.025, 'square', 0.04); },
  thud() { tone(110, 0.22, 'sine', 0.35, 0, 55); noise(0.1, 0.15, 400, 0.7); },
  creak() { noise(0.06, 0.05, 1200 + Math.random() * 900, 6); },
  slide() { noise(0.25, 0.12, 1400, 0.6); },
  drum() { for (let i = 0; i < 24; i++) noise(0.05, 0.05 + i * 0.011, 260 + Math.random() * 200, 0.8, i * 0.042); tone(90, 0.45, 'sine', 0.4, 1.02, 50); noise(0.32, 0.32, 900, 0.6, 1.02); },
  fanfare(big = false) { const n = big ? [523, 659, 784, 1047, 1319] : [523, 659, 784]; n.forEach((f, i) => { tone(f, 0.26, 'triangle', 0.13, i * 0.1); tone(f * 2, 0.2, 'sine', 0.035, i * 0.1); }); },
  cascade() { for (let i = 0; i < 11; i++) tone(2400 + Math.random() * 1000, 0.08, 'triangle', 0.085, i * 0.06 + Math.random() * 0.03); },
  lose() { tone(170, 0.32, 'sine', 0.16, 0, 100); },
  error() { tone(220, 0.07, 'square', 0.07); tone(200, 0.07, 'square', 0.07, 0.11); },
  whoosh() { noise(0.3, 0.1, 1800, 0.5); },
  rose() { noise(0.4, 0.1, 3000, 0.5, 0, 'highpass'); tone(1200, 0.3, 'sine', 0.05, 0.05, 1800); },
  chai() { tone(3100, 0.3, 'sine', 0.12); tone(4300, 0.2, 'sine', 0.06, 0.03); },
  fire() { noise(0.16, 0.55, 1800, 0.5); noise(0.3, 0.2, 600, 0.5, 0.05); for (let i = 0; i < 5; i++) noise(0.03, 0.15, 4000, 1, 0.12 + i * 0.05); },
  tomato() { noise(0.22, 0.38, 420, 0.7); tone(120, 0.14, 'sine', 0.2); },
  clap() { for (let i = 0; i < 9; i++) noise(0.04, 0.25, 1500 + Math.random() * 600, 1, i * 0.085 + Math.random() * 0.03); },
  gong() { tone(98, 1.4, 'sine', 0.3); tone(196, 1.0, 'sine', 0.08); },
};
export type Sfx = keyof typeof SFX;

export function play(name: Sfx, arg?: number | boolean): void {
  ensureAudio();
  try { (SFX[name] as (a?: unknown) => void)(arg); } catch { /* audio unavailable */ }
}
