import { useCallback, useEffect, useRef, useState } from 'react';
import { loadMe, saveMe, tokenFor, type Me } from './lib/identity';
import { createRoom, roomInfo } from './lib/net';
import { ensureAudio, play } from './lib/sound';
import { buzz, HAP } from './lib/haptics';
import { applySettings } from './lib/settings';
import { Room } from './screens/Room';
import { SettingsSheet } from './screens/SettingsSheet';
import { Icon } from './screens/Icon';

export type ToastFn = (text: string) => void;

const ALPH = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function App() {
  const [me, setMe] = useState<Me | null>(loadMe());
  const [screen, setScreen] = useState<'home' | 'join' | 'room'>('home');
  const [code, setCode] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef(0);
  const prefill = useRef<string>(new URLSearchParams(location.search).get('join')?.toUpperCase() ?? '');

  const showToast: ToastFn = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    // Back into your seat after a refresh or the browser closing the tab.
    const saved = sessionOrLocal('danka-room');
    if (loadMe() && saved && ALPH.test(saved) && !prefill.current) { setCode(saved); setScreen('room'); }
    applySettings();
    const unlock = () => ensureAudio();
    document.addEventListener('pointerdown', unlock, { once: true });
    if (prefill.current && loadMe()) setScreen('join');
  }, []);

  const enterRoom = (c: string) => {
    try { localStorage.setItem('danka-room', c); } catch { /* ignore */ }
    setCode(c);
    setScreen('room');
    history.replaceState(null, '', location.pathname);
  };

  const onCreate = async (seats: number) => {
    if (!me || busy) return;
    play('tap'); buzz(HAP.click); setBusy(true);
    try { localStorage.setItem('danka-seats', String(seats)); } catch { /* ignore */ }
    try {
      enterRoom(await createRoom(tokenFor(me), seats));
    } catch (e) {
      play('error'); buzz(HAP.error); showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="app">
      {!me && <NameScreen onDone={(name) => { const m = saveMe(name); setMe(m); if (prefill.current) setScreen('join'); }} />}
      {me && screen === 'home' && (
        <Home me={me} busy={busy}
          onCreate={onCreate}
          onJoin={() => { play('tap'); buzz(HAP.tick); setScreen('join'); }}
          onSettings={() => { play('tap'); setSettingsOpen(true); }}
          onRename={() => { setMe(null); }} />
      )}
      {me && screen === 'join' && (
        <Join prefill={prefill.current} onBack={() => { prefill.current = ''; setScreen('home'); }} onJoined={enterRoom} />
      )}
      {me && screen === 'room' && code && (
        <Room key={code} me={me} code={code} toast={showToast}
          onExit={(msg) => { try { localStorage.removeItem('danka-room'); } catch { /* ignore */ } if (msg) showToast(msg); setCode(null); setScreen('home'); }}
          onSettings={() => setSettingsOpen(true)} />
      )}
      <div id="fx" />
      <div className={`scrim${settingsOpen ? ' on' : ''}`} onClick={() => setSettingsOpen(false)} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} toast={showToast} />
      <div id="toast" className={toast ? 'on' : ''} role="status"><span>{toast}</span></div>
    </div>
  );
}

function NameScreen({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState(loadMe()?.name ?? '');
  const ok = name.trim().length >= 2;
  return (
    <section className="screen" id="join" aria-label="Your name">
      <div className="logo" style={{ marginTop: 40 }}>
        <Logo />
        <h1>DANKA CLUB</h1>
        <p>Your table. Your people.</p>
      </div>
      <div className="join-body">
        <label htmlFor="name-input" className="field-label">Your name at the table</label>
        <input id="name-input" className="text-input" value={name} maxLength={24} autoComplete="nickname"
          placeholder="e.g. Rc" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) onDone(name); }} />
        <button className="btn gold" disabled={!ok} onClick={() => { play('chime'); buzz(HAP.click); onDone(name); }}>Continue</button>
        <p className="fine">Test version: no sign-in yet. Your seat is tied to this phone. Coins have no cash value.</p>
      </div>
    </section>
  );
}

function Home(p: { me: Me; busy: boolean; onCreate: (seats: number) => void; onJoin: () => void; onSettings: () => void; onRename: () => void }) {
  const [sizeOpen, setSizeOpen] = useState(false);
  const last = Number(localStorage.getItem('danka-seats')) || 7;
  return (
    <section className="screen" id="home" aria-label="Home">
      <div className="home-top">
        <button className="chip-tag" onClick={p.onRename}>Playing as <b>{p.me.name}</b> · change</button>
        <button className="icon-btn" aria-label="Settings" onClick={p.onSettings}><Icon name="gear" /></button>
      </div>
      <div className="logo"><Logo /><h1>DANKA CLUB</h1><p>Your table. Your people.</p></div>
      <div className="tiles">
        <button className="tile primary" onClick={() => { play('tap'); buzz(HAP.tick); setSizeOpen(true); }} disabled={p.busy}>
          <span className="t-ic"><Icon name="plus" /></span>
          <span><b>{p.busy ? 'Creating…' : 'Create Room'}</b><span>You enter first, so you deal game 1</span></span>
        </button>
        <button className="tile ghost" onClick={p.onJoin}>
          <span className="t-ic"><Icon name="enter" /></span>
          <span><b>Join Room</b><span>Enter the 6-character code from WhatsApp</span></span>
        </button>
        <div className="rules-card">
          <b>House rules</b>
          <span>100 coins each · Blind 1 · Seen 2 · Bank loan up to 100</span>
          <span>Well Cut → 4 games of 4, 3, 2, 1 cards · 20-minute rounds</span>
        </div>
      </div>
      <p className="fine">Coins have no cash value.</p>
      <div className={`scrim${sizeOpen ? ' on' : ''}`} onClick={() => setSizeOpen(false)} />
      <div className={`sheet${sizeOpen ? ' on' : ''}`} role="dialog" aria-label="How many players?">
        <div className="grab" />
        <h3>How many players?</h3>
        <div className="sheet-body">
          <p className="note" style={{ margin: '0 0 12px' }}>The room holds this many seats. You can change it in the waiting room. Latecomers join at Placecut, every 20 minutes.</p>
          <div className="size-grid">
            {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <button key={n} className={`size-btn${n === last ? ' on' : ''}`} disabled={p.busy} onClick={() => { setSizeOpen(false); p.onCreate(n); }}>
                <b>{n}</b><span className="seats-dots">{Array.from({ length: n }, (_, i) => <i key={i} />)}</span><small>players</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Join({ prefill, onBack, onJoined }: { prefill: string; onBack: () => void; onJoined: (code: string) => void }) {
  const [v, setV] = useState(prefill);
  const [err, setErr] = useState('');
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => input.current?.focus(), 250); }, []);

  const fail = (m: string) => { setErr(m); setShake((n) => n + 1); play('error'); buzz(HAP.error); };
  const go = async () => {
    if (v.length < 6) return fail('Enter all 6 characters.');
    if (!ALPH.test(v)) return fail('That code has 0, O, 1, I or L. Room codes never use them, so check the message again.');
    setBusy(true);
    const r = await roomInfo(v);
    setBusy(false);
    if (!r.ok) return fail(r.message);
    if (r.info.expired) return fail('That room code has expired. Ask for a new one.');
    // Full tables and running rounds are checked when you connect: players already seated can always come back.
    play('tap'); buzz(HAP.click);
    onJoined(v);
  };

  return (
    <section className="screen" id="join" aria-label="Join room">
      <div className="bar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        <h2>Join a room</h2>
      </div>
      <div className="join-body">
        <p>Type the room code your friend shared. Codes never use 0, O, 1, I or L, so they're easy to read out loud.</p>
        <div key={shake} className={`code-wrap${err ? ' err' : ''}${shake ? ' shake' : ''}`}>
          <div className="code-boxes">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className={`${v[i] ? 'filled' : ''}${i === Math.min(v.length, 5) ? ' cur' : ''}`}>{v[i] ?? ''}</div>
            ))}
          </div>
          <input id="code-input" ref={input} value={v} maxLength={6} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-label="Room code"
            onChange={(e) => { setV(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)); setErr(''); play('tick'); buzz(HAP.peek); }}
            onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        </div>
        <div className="err-msg" role="alert">{err}</div>
        <button className="btn gold" disabled={v.length !== 6 || busy} onClick={go}>{busy ? 'Checking…' : 'Join table'}</button>
      </div>
    </section>
  );
}

function sessionOrLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function Logo() {
  return (
    <svg viewBox="0 0 132 104" aria-hidden="true">
      <g transform="translate(66 92)">
        <g transform="rotate(-20)"><rect x="-22" y="-80" width="44" height="64" rx="6" fill="#123238" stroke="#F5EFE3" strokeWidth="2.5" /><path d="M-12 -70 L0 -58 L12 -70 M-12 -40 L0 -52 L12 -40" stroke="#E2B865" strokeWidth="2" fill="none" /></g>
        <g transform="rotate(20)"><rect x="-22" y="-80" width="44" height="64" rx="6" fill="#123238" stroke="#F5EFE3" strokeWidth="2.5" /><path d="M-12 -70 L0 -58 L12 -70 M-12 -40 L0 -52 L12 -40" stroke="#E2B865" strokeWidth="2" fill="none" /></g>
        <g><rect x="-22" y="-86" width="44" height="64" rx="6" fill="#FFFBF2" stroke="#C8963E" strokeWidth="2.5" /><text x="0" y="-44" textAnchor="middle" fontFamily="Baloo 2, sans-serif" fontWeight="800" fontSize="34" fill="#C62828">D</text></g>
      </g>
    </svg>
  );
}
