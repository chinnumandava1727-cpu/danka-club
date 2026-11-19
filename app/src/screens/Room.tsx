import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HAND_MODES, MODE_NAMES, verifyCommitment, type GameEvent, type PlayerView, type SessionMode } from '@danka/engine';
import { tokenFor, type Me } from '../lib/identity';
import { RoomClient, SERVER, type Quality, type ServerMsg, type Status } from '../lib/net';
import { play } from '../lib/sound';
import { buzz, HAP } from '../lib/haptics';
import { settings } from '../lib/settings';
import { burst, centerOf, chip, deckEl, fly, potEl, pulse, seatAvatar, seatMinis, shuffleDeck } from '../lib/fx';
import { CardFace, plural } from '../lib/cards';
import { ModeSheet, type ToastFn } from '../App';
import { Icon } from './Icon';

const COLORS = ['#F4A300', '#81B29A', '#E07A5F', '#F2CC8F', '#B8A1D9', '#6FB7E0', '#E9A6A6'];
// Where the other players sit around the felt, clockwise from your left (you are always bottom-centre).
// The layout spreads out evenly for 2 to 7 players.
type Pos = { x: number; y: number; s: 'sl' | 'sr' };
const L = (x: number, y: number): Pos => ({ x, y, s: x <= 50 ? 'sl' : 'sr' });
const LAYOUTS: Record<number, Pos[]> = {
  1: [L(50, 13)],
  2: [L(24, 15), L(76, 15)],
  3: [L(9, 44), L(50, 13), L(91, 44)],
  4: [L(9, 44), L(24, 15), L(76, 15), L(91, 44)],
  5: [L(13, 71), L(9, 44), L(50, 13), L(91, 44), L(87, 71)],
  6: [L(13, 71), L(9, 44), L(24, 15), L(76, 15), L(91, 44), L(87, 71)],
};
const posFor = (k: number, n: number): Pos | undefined => LAYOUTS[n - 1]?.[k - 1];
const ini = (name: string) => name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
const fmt = (n: number) => n.toLocaleString('en-IN');

const THROWS = {
  rose: { label: 'Rose', snd: 'rose', col: ['#E5484D', '#FF9AA0', '#3FA34D'], svg: '<svg viewBox="0 0 32 32"><path d="M16 30V16" stroke="#3FA34D" stroke-width="2.5"/><path d="M16 22c-4 0-6-3-6-3s3-1 6 1" fill="#3FA34D"/><circle cx="16" cy="11" r="7" fill="#E5484D"/><path d="M12 10c2-3 6-3 8 0M13 13c2 1.5 4 1.5 6 0" stroke="#9E1F28" stroke-width="1.5" fill="none"/></svg>' },
  chai: { label: 'Chai', snd: 'chai', col: ['#B9783C', '#F5EFE3'], svg: '<svg viewBox="0 0 32 32"><path d="M7 12h16l-2 14a3 3 0 0 1-3 2h-6a3 3 0 0 1-3-2z" fill="#F5EFE3"/><path d="M8 15h14" stroke="#B9783C" stroke-width="3"/><path d="M23 15h2a3 3 0 0 1 0 6h-2.5" stroke="#F5EFE3" stroke-width="2" fill="none"/><path d="M12 4c-1 2 1 3 0 5M17 4c-1 2 1 3 0 5" stroke="#9AA6BC" stroke-width="1.6" fill="none"/></svg>' },
  fire: { label: 'Cracker', snd: 'fire', col: ['#F4A300', '#E5484D', '#FFF6DD', '#4C8DFF'], svg: '<svg viewBox="0 0 32 32"><rect x="11" y="12" width="10" height="16" rx="2" fill="#E5484D"/><path d="M11 17h10M11 23h10" stroke="#F4A300" stroke-width="2"/><path d="M16 12c0-3 3-4 2-8" stroke="#9AA6BC" stroke-width="1.6" fill="none"/><circle cx="18" cy="4" r="2.5" fill="#F4A300"/></svg>' },
  tomato: { label: 'Tomato', snd: 'tomato', col: ['#D93A3A', '#FF6B6B', '#3FA34D'], svg: '<svg viewBox="0 0 32 32"><circle cx="16" cy="18" r="10" fill="#D93A3A"/><path d="M11 9l5 3 5-3-3 4h-4z" fill="#3FA34D"/><ellipse cx="12" cy="15" rx="2.5" ry="1.5" fill="#FF8A8A"/></svg>' },
  clap: { label: 'Applause', snd: 'clap', col: ['#F4A300', '#F2CC8F', '#FFF6DD'], svg: '<svg viewBox="0 0 32 32"><path d="M9 20l6-10a2 2 0 0 1 3.5 2L15 18l7-9a2 2 0 0 1 3 2.5L19 21a7 7 0 0 1-11 1z" fill="#F2CC8F"/><path d="M6 8l2 2M10 5l1 3M4 13l3 1" stroke="#F4A300" stroke-width="2" stroke-linecap="round"/></svg>' },
} as const;
type ThrowKind = keyof typeof THROWS;

function bubble(seat: number, text: string) {
  const b = document.querySelector(`[data-seat="${seat}"] .bubble`) as HTMLElement & { _t?: number } | null;
  if (!b) return;
  b.textContent = text;
  b.classList.add('show');
  clearTimeout(b._t);
  b._t = window.setTimeout(() => b.classList.remove('show'), 1700);
}

type Sheet = null | 'ledger' | 'result' | 'leave' | 'modes';

export function Room({ me, code, toast, onExit, onSettings }: { me: Me; code: string; toast: ToastFn; onExit: (msg?: string) => void; onSettings: () => void }) {
  const [view, setView] = useState<PlayerView | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dealing, setDealing] = useState(false);
  const [showing, setShowing] = useState(false);
  const [reactTo, setReactTo] = useState<number | null>(null);
  const [verify, setVerify] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [quality, setQuality] = useState<{ q: Quality; rtt: number }>({ q: 'good', rtt: 0 });
  const client = useRef<RoomClient | null>(null);
  const queue = useRef<GameEvent[]>([]);
  const viewRef = useRef<PlayerView | null>(null);
  viewRef.current = view;

  /* ---------- connection ---------- */
  useEffect(() => {
    const onMsg = (m: ServerMsg) => {
      if (m.t === 'state') {
        setView(m.view);
        queue.current.push(...m.events);
        setTick((t) => t + 1);
      } else if (m.t === 'react') {
        throwAt(m.from, m.to, m.kind);
      } else if (m.t === 'error' && viewRef.current) {
        play('error'); buzz(HAP.error); toast(m.message);
      }
    };
    const c = new RoomClient(code, tokenFor(me), onMsg, (s, detail) => {
      setStatus(s);
      if (s === 'rejected') onExit(detail?.message ?? 'Could not join that room.');
      if (s === 'replaced') onExit('This table is open on another phone or tab.');
      if (s === 'left') onExit();
      if (s === 'closed') onExit('The admin closed the room.');
    }, (q, rtt) => setQuality({ q, rtt }));
    client.current = c;
    const wake = () => { if (document.visibilityState === 'visible') c.wake(); };
    const online = () => c.wake();
    const offline = () => c.offline();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      c.stop();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  /* ---------- keep the screen awake while seated (a sleeping phone drops its connection) ---------- */
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const get = async () => {
      try { if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
    };
    const vis = () => { if (document.visibilityState === 'visible') get(); };
    get();
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release().catch(() => {}); };
  }, []);

  /* ---------- events → sound, haptics, animation ---------- */
  useEffect(() => {
    const v = view;
    if (!v) return;
    const evs = queue.current.splice(0);
    const you = v.you;
    const name = (i: number) => (i === you ? 'You' : v.seats[i]?.name ?? '');
    let sawShow = false;
    for (const e of evs) {
      switch (e.e) {
        case 'joined': if (!e.rejoined && e.seat !== you) { play('knock'); buzz(HAP.land); } break;
        case 'ready': play('tick'); break;
        case 'started': play('gong'); buzz(HAP.rise); break;
        case 'picking': if (e.dealer === you) { play('chime'); buzz(HAP.turn); } break;
        case 'mode': if (e.by !== null && e.by !== you) { toast(`${name(e.by)} picked ${MODE_NAMES[e.mode]}`); bubble(e.by, MODE_NAMES[e.mode] + '!'); play('chime'); } break;
        case 'loan': if (e.seat === you) toast(`Bank loan: +${e.amount} coins`); break;
        case 'boot': e.seats.forEach((s, k) => chip(centerOf(seatAvatar(s)), centerOf(potEl()), k * 60)); play('clink', 3); break;
        case 'commit': shuffleDeck(); play('shuffle'); break;
        case 'wild': play('gong'); toast(`Wild card this hand: ${plural(e.rank)}`); break;
        case 'deal': {
          setDealing(true);
          const per = settings.reduce ? 20 : 75;
          let n = 0;
          for (let r = 0; r < e.cardsEach; r++) for (const s of e.order) {
            const delay = n++ * per;
            const target = s === you ? centerOf(document.querySelectorAll('#my-cards .pc')[r] ?? null) : centerOf(seatMinis(s));
            setTimeout(() => play('flick'), delay);
            fly('fly-card back', '', centerOf(deckEl()), target, 260, { delay, arc: 26, spin: s === you ? 0 : 200, s1: s === you ? 1.6 : 0.7 })
              .then(() => { play('land'); if (s === you) buzz(HAP.land); });
          }
          setTimeout(() => setDealing(false), n * per + 300);
          break;
        }
        case 'turn': if (e.seat === you) { play('chime'); buzz(HAP.turn); } break;
        case 'see': if (e.seat !== you) { bubble(e.seat, 'Seen'); play('creak'); } break;
        case 'bet': {
          chip(centerOf(seatAvatar(e.seat)), centerOf(potEl()));
          play('clink', e.kind === 'raise' ? 3 : e.kind === 'chaal' ? 2 : 1);
          if (e.kind === 'raise') play('slide');
          bubble(e.seat, `${{ blind: 'Blind', chaal: 'Chaal', raise: 'Raise', show: 'Show!' }[e.kind]} ${e.amount}`);
          if (e.seat === you) buzz(e.kind === 'raise' ? HAP.rise : HAP.click);
          break;
        }
        case 'pack': play('thud'); bubble(e.seat, e.reason === 'timeout' ? 'Time up' : 'Pack'); if (e.seat === you) { buzz(HAP.thud); if (e.reason === 'timeout') toast('Time ran out, so you packed'); } break;
        case 'show': {
          sawShow = true;
          setShowing(true); play('drum'); buzz(HAP.drum);
          setTimeout(() => setShowing(false), settings.reduce ? 1500 : 3400);
          break;
        }
        case 'win': {
          const delay = sawShow ? (settings.reduce ? 1200 : 3000) : 300;
          const w = e.seat, iWon = w === you;
          setTimeout(() => {
            const to = centerOf(seatAvatar(w)), from = centerOf(potEl());
            for (let k = 0; k < 9; k++) chip(from && { x: from.x + (Math.random() * 20 - 10), y: from.y }, to, k * 55);
            play('cascade');
            setTimeout(() => { burst(to, ['#F4A300', '#FFF6DD', '#C8963E', '#2FBF71'], 16); play('fanfare', iWon && e.pot >= 200); if (iWon) buzz(HAP.win); }, 650);
          }, delay);
          setTimeout(() => setSheet((s) => (s === null ? 'result' : s)), delay + 1400);
          break;
        }
        case 'out': toast(`${name(e.seat)} ${e.seat === you ? 'are' : 'is'} out of the tournament`); break;
        case 'champion': play('fanfare', true); buzz(HAP.win); setTimeout(() => setSheet('result'), 800); break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // close the result sheet when the next hand starts
  useEffect(() => {
    if (view && view.phase !== 'hand_over' && view.phase !== 'session_over' && sheet === 'result') { setSheet(null); setVerify(null); }
  }, [view?.phase, view, sheet]);

  /* ---------- turn timer ring ---------- */
  useEffect(() => {
    if (!view || view.phase !== 'betting' || !view.deadline || view.turn < 0) return;
    const C = 2 * Math.PI * 28, total = view.turnSeconds * 1000, at = view.deadline.at, turn = view.turn, you = view.you;
    let raf = 0, lastSec = -1;
    const loop = () => {
      const fg = document.querySelector(`[data-seat="${turn}"] .ring .fg`) as SVGCircleElement | null;
      const rem = Math.max(0, at - (client.current?.serverNow() ?? Date.now()));
      if (fg) { fg.style.strokeDasharray = String(C); fg.style.strokeDashoffset = String(C * (1 - rem / total)); fg.classList.toggle('low', rem < 5000); }
      if (turn === you && rem < 5000 && rem > 0) { const s = Math.ceil(rem / 1000); if (s !== lastSec) { lastSec = s; play('tick'); buzz(HAP.tick); } }
      if (rem > 0) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [view?.turn, view?.deadline?.at, view?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- throwables ---------- */
  function throwAt(from: number, to: number, kind: ThrowKind) {
    const t = THROWS[kind];
    if (!t) return;
    play('whoosh');
    fly('proj', t.svg, centerOf(seatAvatar(from)), centerOf(seatAvatar(to)), 650, { arc: 90, spin: kind === 'tomato' ? 540 : 360, s0: 0.6, s1: 1.2 }).then(() => {
      play(t.snd);
      burst(centerOf(seatAvatar(to)), [...t.col], kind === 'fire' ? 22 : 14);
      pulse(seatAvatar(to));
      const v = viewRef.current;
      if (v && to === v.you && from !== v.you) { buzz(HAP.wobble); toast(`${v.seats[from]?.name} threw a ${t.label.toLowerCase()} at you`); }
    });
  }

  if (!view) {
    return (
      <section className="screen" id="lobby">
        <div className="center-msg"><div className="spinner" /><p>{status === 'reconnecting' ? 'Reconnecting…' : `Joining room ${code}…`}</p>
          <button className="btn line" onClick={() => onExit()}>Cancel</button></div>
      </section>
    );
  }

  const send = client.current!;
  const banner = status === 'reconnecting' || quality.q === 'offline'
    ? <div className="status-banner">{navigator.onLine ? 'Connection lost. Reconnecting… your seat is held.' : 'No internet. Your seat is held; you will rejoin automatically.'}</div> : null;

  if (view.phase === 'waiting') return <><Lobby view={view} code={code} client={send} toast={toast} onExit={onExit} onSettings={onSettings} />{banner}</>;

  return (
    <>
      <Table view={view} code={code} client={send} quality={quality} dealing={dealing} onSheet={setSheet} onReact={setReactTo} onSettings={onSettings} />
      {banner}
      <ShowOverlay view={view} on={showing} />
      <div className={`scrim${sheet && sheet !== 'result' ? ' on' : ''}`} onClick={() => setSheet(null)} />
      <ReactMenu view={view} seat={reactTo} onClose={() => setReactTo(null)} onThrow={(kind) => { send.send({ t: 'react', to: reactTo!, kind }); setReactTo(null); }} />
      <ModeSheet open={view.options.pick} current={null} title="Dealer's choice: pick this hand's game" modes={HAND_MODES as readonly SessionMode[]}
        onPick={(m) => { send.send({ t: 'pick', mode: m as (typeof HAND_MODES)[number] }); play('clink', 2); buzz(HAP.click); }} />
      <div className={`sheet${sheet === 'ledger' ? ' on' : ''}`} role="dialog" aria-label="Session ledger">
        <div className="grab" />
        <h3>Session ledger <span className="fine">Coins have no cash value</span></h3>
        <div className="sheet-body">
          {[...view.ledger].reverse().map((l, i) => (
            <div key={i} className={`ledger-item ${l.kind === 'win' ? 'win' : l.kind === 'loan' ? 'loan' : ''}`}>
              <time>{new Date(l.at).toTimeString().slice(0, 5)}</time><span>{l.text}</span>
            </div>
          ))}
        </div>
      </div>
      <ResultSheet open={sheet === 'result'} view={view} client={send} verify={verify}
        onVerify={async () => {
          const r = view.result!;
          const ok = await verifyCommitment(r.commit, r.deck, r.salt);
          setVerify(ok ? 'ok' : 'bad'); play(ok ? 'chime' : 'error'); buzz(ok ? HAP.click : HAP.error);
        }}
        onHome={() => onExit()} />
      <div className={`sheet${sheet === 'leave' ? ' on' : ''}`} role="dialog" aria-label="Leave table">
        <div className="grab" />
        <h3>Leave the table?</h3>
        <div className="confirm-body">
          <p>Your seat stays yours. Open the room again with the same code to come back. If it's your turn while you're away, you pack when the timer ends.</p>
          <div className="row2"><button className="btn line" onClick={() => setSheet(null)}>Stay</button><button className="btn gold" onClick={() => onExit()}>Leave</button></div>
          {view.seats[view.you]?.isAdmin && (view.phase === 'hand_over' || view.phase === 'session_over') && (
            <button className="btn line" style={{ color: '#FF9A9D' }} onClick={() => send.send({ t: 'close' })}>Close the room for everyone</button>
          )}
        </div>
      </div>
    </>
  );
}

/* ================= LOBBY ================= */

function Lobby({ view, code, client, toast, onExit, onSettings }: { view: PlayerView; code: string; client: RoomClient; toast: ToastFn; onExit: (m?: string) => void; onSettings: () => void }) {
  const [modes, setModes] = useState(false);
  const me = view.seats[view.you];
  const isAdmin = !!me?.isAdmin;
  const n = view.seats.length;
  const min = view.minPlayers;
  const size = view.maxSeats;
  const full = n >= size;
  const allReady = n >= min && view.seats.every((s) => s.ready);
  const setSize = (v: number) => { client.send({ t: 'size', size: v }); play('tick'); buzz(HAP.tick); };
  const link = `${SERVER}/j/${code}`;
  const share = async () => {
    const text = `Join my DANKA CLUB table! Room code: ${code}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'DANKA CLUB', text, url: link }); return; }
      await navigator.clipboard.writeText(`${text}\n${link}`);
      toast('Invite copied. Paste it in WhatsApp.');
    } catch { /* user cancelled */ }
  };
  return (
    <section className="screen" id="lobby" aria-label="Waiting room">
      <div className="bar">
        <button className="icon-btn" aria-label="Leave waiting room" onClick={() => { if (isAdmin) onExit(); else client.send({ t: 'leave' }); }}><Icon name="back" /></button>
        <h2>Waiting room</h2>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="Settings" onClick={onSettings}><Icon name="sliders" /></button>
      </div>
      <div className="room-card">
        <div><small>Room code</small><div className="room-code">{code}</div></div>
        <button className="btn line" style={{ height: 46 }} onClick={share}><Icon name="share" />Invite</button>
      </div>
      <div className="lobby-status"><span>{!full ? `Waiting for ${size - n} more player${size - n === 1 ? '' : 's'}` : allReady ? `All ${n} ready` : 'Table full. Tap ready.'}</span><b className="num">{n}/{size}</b></div>
      <div className="progress"><i style={{ width: `${(n / size) * 100}%` }} /></div>
      {isAdmin && (
        <div className="size-row">
          <span><small>Table size</small><b>{size} players</b></span>
          <span className="stepper">
            <button aria-label="One seat fewer" disabled={size <= Math.max(min, n)} onClick={() => setSize(size - 1)}>−</button>
            <button aria-label="One seat more" disabled={size >= 7} onClick={() => setSize(size + 1)}>+</button>
          </span>
        </div>
      )}
      <button className="mode-row" onClick={() => { if (!isAdmin) { play('error'); toast('Only the admin can change the game mode'); return; } play('tap'); setModes(true); }}>
        <span><small>{isAdmin ? 'Game mode · tap to change' : 'Game mode · set by the admin'}</small><b>{MODE_NAMES[view.sessionMode]}</b></span><Icon name="chevron" />
      </button>
      <div className="seat-list">
        {Array.from({ length: size }, (_, i) => {
          const s = view.seats[i];
          if (!s) return <div key={i} className="lrow empty"><span className="ord">#{i + 1}</span>Open seat</div>;
          return (
            <div key={i} className="lrow pop">
              <span className="ord">#{i + 1}</span>
              <span className="lav" style={{ background: COLORS[i] }}>{ini(s.name)}</span>
              <span className="who"><b>{i === view.you ? `${s.name} (you)` : s.name}</b>
                <span className="badges">{s.isAdmin && <span className="badge">Admin</span>}{i === 0 && <span className="badge deal">Deals game 1</span>}{!s.connected && <span className="badge">Offline</span>}</span></span>
              <span className={`ready${s.ready ? ' ok' : ''}`}>{s.ready ? 'Ready' : 'Not ready'}</span>
            </div>
          );
        })}
      </div>
      <p className="rule-note">Seat #1 deals game 1, then each winner deals. If someone is late, start without them: they can join any time and play from the next hand.</p>
      <div className="lobby-actions">
        <button className="btn line" onClick={() => { client.send({ t: 'ready', ready: !me?.ready }); play('clink'); buzz(HAP.click); }}>{me?.ready ? 'Not ready' : "I'm ready"}</button>
        {isAdmin
          ? <button className="btn gold" disabled={!view.options.start} onClick={() => { client.send({ t: 'start' }); }}>{full ? 'Start game' : n >= min ? `Start with ${n} of ${size}` : 'Start game'}</button>
          : <button className="btn gold" disabled>Admin starts</button>}
      </div>
      <div className={`scrim${modes ? ' on' : ''}`} onClick={() => setModes(false)} />
      <ModeSheet open={modes} current={view.sessionMode} onPick={(m) => { client.send({ t: 'mode', mode: m }); setModes(false); play('chime'); }} />
    </section>
  );
}

/* ================= TABLE ================= */

function Table({ view, code, client, quality, dealing, onSheet, onReact, onSettings }: { view: PlayerView; code: string; client: RoomClient; quality: { q: Quality; rtt: number }; dealing: boolean; onSheet: (s: Sheet) => void; onReact: (seat: number) => void; onSettings: () => void }) {
  const you = view.you, n = view.seats.length;
  const me = view.seats[you];
  const cardsVisible = view.phase !== 'dealing' && view.phase !== 'picking' && !dealing;
  const o = view.options;
  const dealerBtn = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);

  // slide the dealer button next to the dealer
  useLayoutEffect(() => {
    const d = dealerBtn.current, a = area.current?.getBoundingClientRect(), av = document.querySelector(`[data-seat="${view.dealer}"] .av`)?.getBoundingClientRect();
    if (!d || !a || !av) return;
    let x = av.left - a.left + av.width / 2, y = av.top - a.top + av.height / 2;
    const k = (view.dealer - you + n) % n;
    if (k === 0) { x += 34; y -= 30; } else if (posFor(k, n)?.s !== 'sr') { x += 30; y += 22; } else { x -= 30; y += 22; }
    d.style.left = `${x}px`; d.style.top = `${y}px`;
  }, [view.dealer, you, n]);

  const modeInfo = view.handMode === 'muflis' ? 'Muflis · lowest wins' : view.handMode === 'ak47' ? 'AK47 · A K 4 7 are wild' : view.handMode === 'joker' && view.wild ? `Wild: ${plural(view.wild)}` : view.handMode === 'four' ? 'Best 3 of 4 cards' : view.sessionMode === 'tour' ? `Tournament · boot ${view.boot}` : '';
  const dealLeft = view.deadline?.kind === 'deal' ? Math.max(0, Math.ceil((view.deadline.at - client.serverNow()) / 1000)) : 0;
  const [, force] = useState(0);
  useEffect(() => { if (!o.deal) return; const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, [o.deal]);
  // Lock the bet buttons from the tap until the server confirms, so a double tap can't send two bets.
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [view]);
  useEffect(() => { if (!busy) return; const t = setTimeout(() => setBusy(false), 4000); return () => clearTimeout(t); }, [busy]);
  const bet = (a: 'pack' | 'chaal' | 'raise' | 'show' | 'see') => { if (busy && a !== 'see') return; if (a !== 'see') setBusy(true); client.act({ type: a }); };

  const status =
    view.phase === 'picking' ? `${view.dealer === you ? 'You are' : view.seats[view.dealer].name + ' is'} picking the game…`
    : view.waitingForNextHand ? 'You joined during this hand. You are dealt in from the next hand.'
    : view.phase === 'dealing' ? (o.deal ? 'You are the dealer. Tap the deck to deal.' : `${view.seats[view.dealer].name} is dealing`)
    : view.phase === 'betting' ? (me.status !== 'in' ? 'You packed. Watching the rest of the hand.' : view.turn === you ? `Your turn. ${me.seen ? 'You are Seen, so you bet double.' : 'You are playing Blind.'}` : view.seats[view.turn]?.connected === false ? `${view.seats[view.turn]?.name} lost connection. Seat held; they pack if time runs out.` : `${view.seats[view.turn]?.name} is thinking…`)
    : view.phase === 'hand_over' ? `${view.result ? (view.result.winner === you ? 'You win' : view.seats[view.result.winner].name + ' wins') : ''} the pot`
    : view.phase === 'session_over' ? 'Tournament over' : '';

  return (
    <section className="screen" id="table" aria-label="Card table">
      <div className="topbar">
        <button className="icon-btn" aria-label="Leave table" onClick={() => { play('tap'); onSheet('leave'); }}><Icon name="home" /></button>
        <span className="room-chip">{code}</span>
        <span className="hand-no num">Hand {view.hand} · {view.modeName}</span>
        <span className={`signal ${quality.q}`} role="img" aria-label={quality.q === 'offline' ? 'Offline' : `Connection ${quality.q}, ${Math.round(quality.rtt)} ms`} title={quality.q === 'offline' ? 'Offline' : `${Math.round(quality.rtt)} ms`}><i /><i /><i /></span>
        <button className="icon-btn" aria-label="Ledger" onClick={() => { play('tap'); onSheet('ledger'); }}><Icon name="ledger" /></button>
        <button className="icon-btn" aria-label="Settings" onClick={onSettings}><Icon name="sliders" /></button>
      </div>
      <div id="table-area" ref={area}>
        <div className="felt" />
        <div className="center">
          <div id="deck" role="button" aria-label={o.deal ? 'Tap to deal' : 'Deck'} className={o.deal ? 'pulse' : ''} onClick={() => { if (o.deal) { client.send({ t: 'deal' }); buzz(HAP.click); } }}>
            <div className="dk back" /><div className="dk back" /><div className="dk back" />
          </div>
          <div className="fp num">{view.commit ? `Fingerprint ${view.commit.slice(0, 8)}` : 'Fingerprint ········'}</div>
          <div className="deal-prompt">{o.deal ? `Tap to deal · ${dealLeft}` : ''}</div>
          <div className="pot"><small>POT</small><b className="num">{fmt(view.pot)}</b></div>
          <div className="stake num">{view.phase === 'betting' ? `Blind ${view.stake} · Seen ${view.stake * view.seenMultiplier}` : `Boot ${view.boot}`}</div>
          {modeInfo && <div className="mode-info">{modeInfo}</div>}
        </div>
        {view.seats.map((s, i) => {
          if (i === you) return null;
          const k = (i - you + n) % n, pos = posFor(k, n);
          if (!pos) return null;
          const cls = ['seat', pos.s, view.turn === i ? 'turn' : '', s.status === 'packed' ? 'packed' : '', s.status === 'out' ? 'out' : '', s.seen && s.status === 'in' ? 'seen-st' : ''].join(' ');
          return (
            <div key={i} className={cls} data-seat={i} style={{ left: `${pos.x}%`, top: `${pos.y}%` }}>
              <div className="av-wrap">
                <svg className="ring" viewBox="0 0 60 60"><circle className="bg" cx="30" cy="30" r="28" /><circle className="fg" cx="30" cy="30" r="28" /></svg>
                <button className="av" style={{ background: COLORS[i % 7] }} aria-label={`${s.name}: throw something`} onClick={() => { play('tap'); buzz(HAP.tick); onReact(i); }}>{ini(s.name)}</button>
                <span className={`dot${s.connected ? '' : ' amber'}`} />
                <div className="bubble" />
                <div className="minis">{cardsVisible && s.status !== 'out' && Array.from({ length: s.cardCount }, (_, c) => <div key={c} className="mini back" />)}</div>
              </div>
              <div className="nm">{s.name}</div>
              <div className="co num">{fmt(s.coins)}</div>
              <Tag s={s} phase={view.phase} />
            </div>
          );
        })}
        <div id="dealer-btn" ref={dealerBtn}>D</div>
      </div>
      <div className={`me${view.turn === you ? ' turn' : ''}${me.status !== 'in' ? ' packed' : ''}`} id="me" data-seat={you}>
        <div className="me-left">
          <div className="av-wrap">
            <svg className="ring" viewBox="0 0 60 60"><circle className="bg" cx="30" cy="30" r="28" /><circle className="fg" cx="30" cy="30" r="28" /></svg>
            <div className="av">{ini(me.name)}</div><span className="dot" /><div className="bubble" />
          </div>
          <div className="co num">{fmt(me.coins)}</div>
          <Tag s={me} phase={view.phase} />
        </div>
        <MyCards view={view} visible={cardsVisible} onSee={() => { if (o.see) client.act({ type: 'see' }); }} />
        <div className="me-right">
          <div className="hand-name">{view.yourHand ?? ''}</div>
          <div className="squeeze-hint">{!cardsVisible ? '' : me.seen ? (me.loan ? `Loan ${fmt(me.loan)}` : 'You are Seen') : me.status === 'in' ? 'Drag up on your cards to squeeze' : ''}</div>
        </div>
      </div>
      <div className="actions">
        <div className="status-line">{status}</div>
        <div className="abtns">
          <button className="ab pack" disabled={!o.pack || busy} onClick={() => bet('pack')}>Pack<small>fold</small></button>
          {!me.seen && <button className="ab see" disabled={!o.see} onClick={() => bet('see')}>See<small>cards</small></button>}
          <button className="ab chaal" disabled={o.chaal === null || busy} onClick={() => bet('chaal')}>
            <span>{me.seen ? 'Chaal' : 'Blind'}</span><small className="num">{o.chaal ?? view.stake * (me.seen ? view.seenMultiplier : 1)}</small></button>
          <button className="ab raise" disabled={o.raise === null || busy} onClick={() => bet('raise')}>Raise<small className="num">{o.raise ?? '—'}</small></button>
          {o.show !== null && <button className="ab show" disabled={busy} onClick={() => bet('show')}>Show<small className="num">{o.show}</small></button>}
        </div>
      </div>
    </section>
  );
}

function Tag({ s, phase }: { s: PlayerView['seats'][number]; phase: PlayerView['phase'] }) {
  if (s.status === 'out') return <span className="tag out">Out</span>;
  if (s.status === 'packed' && s.cardCount === 0 && (phase === 'betting' || phase === 'dealing' || phase === 'hand_over')) return <span className="tag out">Next hand</span>;
  if (s.status === 'packed') return <span className="tag packed">Packed</span>;
  if (s.seen) return <span className="tag seen"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>Seen</span>;
  return <span className="tag blind"><svg viewBox="0 0 24 24"><path d="M2 12s4-6 10-6 10 6 10 6M4 15l2-2M20 15l-2-2M12 17v-3" /></svg>Blind</span>;
}

/* ---------- my cards: squeeze, double-tap, swipe down to pack ---------- */
function MyCards({ view, visible, onSee }: { view: PlayerView; visible: boolean; onSee: () => void }) {
  const me = view.seats[view.you];
  const cards = me.cards ?? [];
  const count = Math.max(cards.length, view.handMode === 'four' ? 4 : 3);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; p: number; step: number; lastTap: number; warned: boolean }>({ y0: NaN, p: 0, step: 0, lastTap: 0, warned: false });
  const seen = me.seen;

  const flips = () => Array.from(area.current?.querySelectorAll<HTMLElement>('.flip') ?? []);
  useEffect(() => { if (seen) flips().forEach((f) => { f.classList.remove('dragging'); f.style.transform = ''; }); }, [seen]);

  const down = (e: React.PointerEvent) => {
    if (!visible || !cards.length || me.status !== 'in') return;
    drag.current.y0 = e.clientY; drag.current.p = 0; drag.current.step = 0;
    area.current?.setPointerCapture(e.pointerId);
    if (!seen) flips().forEach((f) => f.classList.add('dragging'));
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (Number.isNaN(d.y0) || seen) return;
    d.p = Math.max(0, Math.min(1, -(e.clientY - d.y0) / 130));
    flips().forEach((f, k) => { const pk = Math.max(0, Math.min(1, d.p * 1.15 - k * 0.07)); f.style.transform = `translateY(${-pk * 14}px) rotateX(${180 - 180 * pk}deg)`; });
    const step = Math.floor(d.p * 10);
    if (step !== d.step) { d.step = step; if (step > 0) { buzz(HAP.peek); play('creak'); } }
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    if (Number.isNaN(d.y0)) return;
    const dy = e.clientY - d.y0; d.y0 = NaN;
    const now = performance.now();
    if (Math.abs(dy) < 8) { if (now - d.lastTap < 320 && !seen) { onSee(); buzz(HAP.click); } d.lastTap = now; }
    if (!seen) {
      if (d.p >= 0.35) { onSee(); buzz(HAP.click); }
      else flips().forEach((f) => { f.classList.remove('dragging'); f.style.transform = ''; });
    }
  };

  return (
    <div id="my-cards" ref={area} className={count === 4 ? 'n4' : ''} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      aria-label="Your cards. Drag up to squeeze or double-tap to see them.">
      {Array.from({ length: count }, (_, k) => (
        <div key={k} className={`pc${visible && cards[k] ? '' : ' empty'}`}>
          <div className={`flip${seen ? ' up' : ''}`}>
            {cards[k] && <CardFace code={cards[k]} mode={view.handMode} wild={view.wild} />}
            <div className="bk back" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Show overlay ---------- */
function ShowOverlay({ view, on }: { view: PlayerView; on: boolean }) {
  const sh = view.result?.show;
  const [flipped, setFlipped] = useState(false);
  useEffect(() => { if (!on) { setFlipped(false); return; } const t = setTimeout(() => { setFlipped(true); play('flick'); }, settings.reduce ? 200 : 1100); return () => clearTimeout(t); }, [on]);
  if (!sh) return null;
  const w = view.result!.winner;
  const side = (seat: number, cards: string[], hand: string) => (
    <div className={`sh${flipped ? (seat === w ? ' win' : ' lose') : ''}`}>
      <b>{seat === view.you ? 'You' : view.seats[seat].name}</b>
      <div className="sh-cards">{cards.map((c) => <div key={c} className="pc2"><div className={`flip${flipped ? ' up' : ''}`}><CardFace code={c} mode={view.handMode} wild={view.wild} /><div className="bk back" /></div></div>)}</div>
      <div className="hn">{flipped ? hand : ''}</div>
    </div>
  );
  return (
    <>
      <div className={`scrim${on ? ' on' : ''}`} style={{ zIndex: 41 }} />
      <div id="show-ov" className={on ? 'on' : ''}>
        <div className="panel">
          <h4>SHOW</h4>
          <div className="show-hands">
            {side(sh.requester, sh.requesterCards, sh.requesterHand.name)}
            {side(sh.opponent, sh.opponentCards, sh.opponentHand.name)}
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- result / champion ---------- */
function ResultSheet({ open, view, client, verify, onVerify, onHome }: { open: boolean; view: PlayerView; client: RoomClient; verify: string | null; onVerify: () => void; onHome: () => void }) {
  const [, force] = useState(0);
  useEffect(() => { if (!open) return; const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, [open]);
  const me = view.seats[view.you];
  if (view.phase === 'session_over') {
    const c = view.champion ?? 0;
    return (
      <div className={`sheet${open ? ' on' : ''}`} id="result" role="dialog" aria-label="Tournament result">
        <div className="grab" />
        <div className="res-top"><div className="lav" style={{ background: COLORS[c] }}>{ini(view.seats[c].name)}</div>
          <div><b>{c === view.you ? 'You are the champion!' : `${view.seats[c].name} is the champion`}</b><span>Tournament Night · {view.hand - 1} hands</span></div></div>
        <div className="sheet-body">
          {[...view.seats].map((s, i) => ({ s, i })).sort((a, b) => b.s.coins - a.s.coins).map(({ s, i }) => (
            <div key={i} className="ledger-item"><time>#{i + 1}</time><span>{s.name}: {fmt(s.coins)} coins</span></div>
          ))}
        </div>
        <div className="res-btns" style={{ gridTemplateColumns: '1fr' }}><button className="btn gold" onClick={onHome}>Back to home</button></div>
      </div>
    );
  }
  const r = view.result;
  if (!r) return <div className="sheet" id="result" />;
  const w = view.seats[r.winner];
  const left = view.deadline?.kind === 'next_hand' ? Math.max(0, Math.ceil((view.deadline.at - client.serverNow()) / 1000)) : 0;
  const sub = r.show
    ? `Show: ${r.winner === r.show.requester ? r.show.requesterHand.name : r.show.opponentHand.name} beats ${r.winner === r.show.requester ? r.show.opponentHand.name : r.show.requesterHand.name}`
    : 'Everyone else packed';
  return (
    <div className={`sheet${open ? ' on' : ''}`} id="result" role="dialog" aria-label="Hand result">
      <div className="grab" />
      <div className="res-top"><div className="lav" style={{ background: COLORS[r.winner] }}>{ini(w.name)}</div>
        <div><b>{r.winner === view.you ? 'You win' : `${w.name} wins`} {fmt(r.pot)}</b><span>{sub}</span></div></div>
      <div className="res-stats">
        <div><small>Your coins</small><b className="num">{fmt(me.coins)}</b></div>
        <div><small>Your loans</small><b className="num">{fmt(me.loan)}</b></div>
        <div><small>Next dealer</small><b>{r.winner === view.you ? 'You' : w.name}</b></div>
      </div>
      <div className={`verify${verify ? ' on' : ''}`}>
        {verify === 'ok'
          ? <><span className="ok">✓ Fingerprint matches</span>: the deck was fixed before the deal and not changed during the hand.<br />Fingerprint: <code>{r.commit.slice(0, 16)}…</code><br />Deck order: <code>{r.deck}</code></>
          : <span style={{ color: '#FF8A8E' }}>✗ Mismatch: this deck does not match the fingerprint.</span>}
      </div>
      <div className="res-btns">
        <button className="btn line" onClick={onVerify}>Verify fairness</button>
        <button className="btn gold" disabled={!view.options.next} onClick={() => { client.send({ t: 'next' }); play('tap'); buzz(HAP.click); }}>Next hand{left ? ` (${left})` : ''}</button>
      </div>
    </div>
  );
}

/* ---------- throwables menu ---------- */
function ReactMenu({ view, seat, onClose, onThrow }: { view: PlayerView; seat: number | null; onClose: () => void; onThrow: (k: ThrowKind) => void }) {
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (seat === null) return;
    const c = centerOf(seatAvatar(seat));
    const aw = document.getElementById('app')!.clientWidth;
    if (c) setPos({ left: Math.max(10, Math.min(aw - 246, c.x - 118)), top: c.y + 40 });
  }, [seat]);
  useEffect(() => {
    if (seat === null) return;
    const h = (e: PointerEvent) => { if (!(e.target as Element).closest('#react-menu') && !(e.target as Element).closest('.seat .av')) onClose(); };
    document.addEventListener('pointerdown', h);
    return () => document.removeEventListener('pointerdown', h);
  }, [seat, onClose]);
  if (seat === null) return null;
  const s = view.seats[seat];
  return (
    <div id="react-menu" className="on" role="dialog" aria-label="Throw something" style={pos}>
      <div className="rm-head"><b>{s.name}</b><span className="num">{fmt(s.coins)} coins</span></div>
      <div className="throws">
        {(Object.keys(THROWS) as ThrowKind[]).map((k) => (
          <button key={k} aria-label={`Throw ${THROWS[k].label}`} onClick={() => onThrow(k)} dangerouslySetInnerHTML={{ __html: THROWS[k].svg }} />
        ))}
      </div>
    </div>
  );
}
