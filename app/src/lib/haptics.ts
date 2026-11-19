import { settings } from './settings';

// Patterns: on-off durations in ms. The Capacitor build swaps this for native haptics.
export const HAP = {
  tick: 8,
  click: 18,
  turn: [24, 60, 24],
  thud: 42,
  land: 10,
  win: [20, 40, 20, 40, 70, 40, 90],
  wobble: [12, 30, 12, 30, 12],
  error: [40, 50, 40],
  rise: [10, 20, 14, 20, 20, 20, 32],
  low: 26,
  peek: 6,
  drum: [20, 60, 20, 60, 20, 60, 30, 60, 40],
} as const;

export function buzz(p: number | readonly number[]): void {
  if (!settings.haptics) return;
  try {
    if (!navigator.vibrate) return;
    const arr = (Array.isArray(p) ? p : [p]).map((v, i) => (i % 2 === 0 ? Math.max(1, Math.round(v * settings.intensity)) : v));
    navigator.vibrate(arr);
  } catch { /* not supported */ }
}
