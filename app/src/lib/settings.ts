export interface Settings {
  sound: boolean;
  vol: number;
  haptics: boolean;
  intensity: number;
  four: boolean;
  warn: boolean;
  theme: 'godavari' | 'maroon' | 'green';
  reduce: boolean;
}

export const DEFAULT_SETTINGS: Settings = { sound: true, vol: 0.7, haptics: true, intensity: 1, four: false, warn: true, theme: 'godavari', reduce: false };

function load(): Settings {
  const s = { ...DEFAULT_SETTINGS };
  try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) s.reduce = true; } catch { /* ignore */ }
  try { Object.assign(s, JSON.parse(localStorage.getItem('danka-settings') || '{}')); } catch { /* ignore */ }
  return s;
}

/** Live settings object, read by sound/haptics/fx without re-rendering. */
export const settings: Settings = load();

export function saveSettings(next: Partial<Settings>): Settings {
  Object.assign(settings, next);
  try { localStorage.setItem('danka-settings', JSON.stringify(settings)); } catch { /* ignore */ }
  applySettings();
  return { ...settings };
}

export function applySettings(): void {
  document.documentElement.dataset.table = settings.theme;
  const app = document.getElementById('app');
  app?.classList.toggle('four', settings.four);
  app?.classList.toggle('reduce', settings.reduce);
}
