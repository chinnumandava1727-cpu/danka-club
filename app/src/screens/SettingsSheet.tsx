import { useState } from 'react';
import { DEFAULT_SETTINGS, saveSettings, settings, type Settings } from '../lib/settings';
import { play } from '../lib/sound';
import { buzz, HAP } from '../lib/haptics';
import type { ToastFn } from '../App';

type Tab = 'sound' | 'haptics' | 'game' | 'display';

export function SettingsSheet({ open, onClose, toast }: { open: boolean; onClose: () => void; toast: ToastFn }) {
  const [s, setS] = useState<Settings>({ ...settings });
  const [tab, setTab] = useState<Tab>('sound');
  const set = (patch: Partial<Settings>) => setS(saveSettings(patch));
  const Switch = ({ k, label, sub, after }: { k: keyof Settings; label: string; sub: string; after?: (v: boolean) => void }) => (
    <div className="set-row">
      <div className="lbl"><b>{label}</b><small>{sub}</small></div>
      <button className="switch" role="switch" aria-label={label} aria-checked={!!s[k]}
        onClick={() => { const v = !s[k]; set({ [k]: v } as Partial<Settings>); play('tap'); buzz(HAP.tick); after?.(v); }} />
    </div>
  );
  const Seg = <T extends string | number>({ value, options, on }: { value: T; options: [T, string][]; on: (v: T) => void }) => (
    <div className="seg">{options.map(([v, l]) => <button key={String(v)} className={v === value ? 'on' : ''} onClick={() => on(v)}>{l}</button>)}</div>
  );

  return (
    <div className={`sheet${open ? ' on' : ''}`} role="dialog" aria-label="Settings">
      <div className="grab" />
      <h3>Settings <button className="btn line" style={{ height: 36, fontSize: 13 }} onClick={() => { setS(saveSettings({ ...DEFAULT_SETTINGS })); play('chime'); toast('Settings reset to default'); }}>Reset to default</button></h3>
      <div className="tabs">
        {(['sound', 'haptics', 'game', 'display'] as Tab[]).map((t) => (
          <button key={t} className={`tab${tab === t ? ' on' : ''}`} onClick={() => { setTab(t); play('tap'); buzz(HAP.tick); }}>
            {{ sound: 'Sound', haptics: 'Haptics', game: 'Gameplay', display: 'Display' }[t]}
          </button>
        ))}
      </div>
      <div className="sheet-body">
        {tab === 'sound' && <div className="set-group on">
          <Switch k="sound" label="Sound effects" sub="Cards, chips, chimes and celebrations" after={(v) => v && play('clink', 2)} />
          <div className="set-row col"><div className="lbl"><b>Effects volume</b><small>Release the slider to hear a chip</small></div>
            <input type="range" min="0" max="1" step="0.05" value={s.vol} aria-label="Effects volume"
              onChange={(e) => set({ vol: +e.target.value })} onPointerUp={() => play('clink', 2)} /></div>
        </div>}
        {tab === 'haptics' && <div className="set-group on">
          <Switch k="haptics" label="Vibration" sub="Only for your actions and things aimed at you" after={(v) => v && buzz(HAP.turn)} />
          <div className="set-row col"><div className="lbl"><b>Intensity</b><small>Tap to feel each level</small></div>
            <Seg value={s.intensity} options={[[0.6, 'Light'], [1, 'Medium'], [1.5, 'Strong']]} on={(v) => { set({ intensity: v }); buzz(HAP.turn); }} /></div>
          <div className="set-row col"><div className="lbl"><b>Try a pattern</b></div>
            <div className="test-row">
              <button onClick={() => { buzz(HAP.turn); play('chime'); }}>Your turn</button>
              <button onClick={() => { buzz(HAP.click); play('clink'); }}>Chip bet</button>
              <button onClick={() => { buzz(HAP.win); play('fanfare', true); }}>You win</button>
              <button onClick={() => { buzz(HAP.wobble); play('tomato'); }}>Throw hits you</button>
            </div></div>
          <p className="note">Vibration works in Chrome on Android. iPhones do not let websites vibrate; the Android app uses native haptics.</p>
        </div>}
        {tab === 'game' && <div className="set-group on">
          <Switch k="four" label="Four-colour deck" sub="Blue diamonds, green clubs: easier on small screens" />
          <Switch k="warn" label="Peek warning" sub="Remind me that squeezing past halfway makes me Seen" />
          <p className="note">Turn time and all betting rules come from the room's house rules, not from this phone.</p>
        </div>}
        {tab === 'display' && <div className="set-group on">
          <div className="set-row col"><div className="lbl"><b>Table theme</b></div>
            <div className="swatches">
              {([['godavari', 'Godavari Night', 'radial-gradient(#0F3D3E,#0A2B2C)'], ['maroon', 'Royal Maroon', 'radial-gradient(#5A1E2A,#3B111B)'], ['green', 'Classic Green', 'radial-gradient(#1D5B32,#103B20)']] as const).map(([v, l, bg]) => (
                <button key={v} className={`sw${s.theme === v ? ' on' : ''}`} style={{ background: bg }} onClick={() => { set({ theme: v }); play('chime'); buzz(HAP.click); }}>{l}</button>
              ))}
            </div></div>
          <Switch k="reduce" label="Reduce motion" sub="Shorter animations, no arcs" />
        </div>}
        <button className="btn line" style={{ width: '100%', marginTop: 12 }} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
