import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { barPosition, verifyCommitment, type CutBar, type GameEvent, type PlayerView } from '@danka/engine';
import { tokenFor, type Me } from '../lib/identity';
import { RoomClient, SERVER, type Quality, type ServerMsg, type Status } from '../lib/net';
import { play } from '../lib/sound';
import { buzz, HAP } from '../lib/haptics';
import { settings } from '../lib/settings';
import { burst, centerOf, chip, deckEl, fly, potEl, pulse, seatAvatar, seatMinis, shuffleDeck } from '../lib/fx';
import { CardFace } from '../lib/cards';
import { deliverPdf, settlementPdf } from '../lib/pdf';
import type { ToastFn } from '../App';
import { Icon } from './Icon';

const COLORS = ['#F4A300', '#81B29A', '#E07A5F', '#F2CC8F', '#B8A1D9', '#6FB7E0', '#E9A6A6', '#9FD3C7', '#D9A5F2', '#C9D97A'];
const colorOf = (i: number) => COLORS[i % COLORS.length];
// Where the other players sit around the felt, clockwise from your left (you are always bottom-centre).
type Pos = { x: number; y: number; s: 'sl' | 'sr' };
const L = (x: number, y: number): Pos => ({ x, y, s: x <= 50 ? 'sl' : 'sr' });
const LAYOUTS: Record<number, Pos[]> = {
  1: [L(50, 13)],
  2: [L(24, 15), L(76, 15)],
  3: [L(9, 44), L(50, 13), L(91, 44)],
  4: [L(9, 44), L(24, 15), L(76, 15), L(91, 44)],
  5: [L(13, 71), L(9, 44), L(50, 13), L(91, 44), L(87, 71)],
  6: [L(13, 71), L(9, 44), L(24, 15), L(76, 15), L(91, 44), L(87, 71)],
  7: [L(13, 75), L(8, 51), L(15, 26), L(50, 10), L(85, 26), L(92, 51), L(87, 75)],
  8: [L(13, 77), L(8, 55), L(11, 32), L(33, 11), L(67, 11), L(89, 32), L(92, 55), L(87, 77)],
  9: [L(14, 80), L(8, 61), L(9, 40), L(20, 18), L(50, 9), L(80, 18), L(91, 40), L(92, 61), L(86, 80)],
};
const posFor = (k: number, n: number): Pos | undefined => LAYOUTS[n - 1]?.[k - 1];
const ini = (name: string) => name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
const fmt = (n: number) => n.toLocaleString('en-IN');
const sgn = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const BET_LABEL = { blind: 'Blind', seen: 'Seen', show: 'Show!', sideshow: 'Sideshow' } as const;

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

/** Re-render every `ms` so countdowns stay live. */
function useTicker(ms: number, on = true) {
  const [, force] = useState(0);
  useEffect(() => { if (!on) return; const t = setInterval(() => force((x) => x + 1), ms); return () => clearInterval(t); }, [ms, on]);
}

type Sheet = null | 'ledger' | 'result' | 'leave' | 'admin' | 'loan' | 'lend';
type Banner = { title: string; sub: string; kind: 'wellcut' | 'bonus' | 'round' } | null;
/** The timing bar's result, held on screen for a moment after the dealer stops it. */
type Frozen = { pos: number; off: number; wellCut: boolean; zone: number; auto: boolean } | null;

export function Room({ me, code, toast, onExit, onSettings }: { me: Me; code: string; toast: ToastFn; onExit: (msg?: string) => void; onSettings: () => void }) {
  const [view, setView] = useState<PlayerView | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dealing, setDealing] = useState(false);
  /** §4 Round-by-round deal on screen: which card round is flying, and how many rounds have landed. */
  const [dealRound, setDealRound] = useState<{ r: number; of: number } | null>(null);
  const [landed, setLanded] = useState(0);
  const [showing, setShowing] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [frozen, setFrozen] = useState<Frozen>(null);
  const frozenTimer = useRef(0);
  const [reactTo, setReactTo] = useState<number | null>(null);
  const [verify, setVerify] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [tick, setTick] = useState(0);
  const [quality, setQuality] = useState<{ q: Quality; rtt: number }>({ q: 'good', rtt: 0 });
  const client = useRef<RoomClient | null>(null);
  const queue = useRef<GameEvent[]>([]);
  const viewRef = useRef<PlayerView | null>(null);
  const bannerTimer = useRef(0);
  viewRef.current = view;

  const showBanner = (b: NonNullable<Banner>, ms = 2800) => {
    setBanner(b);
    clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), settings.reduce ? 1600 : ms);
  };

  /* ---------- connection ---------- */
  useEffect(() => {
    const onMsg = (m: ServerMsg) => {
      if (m.t === 'state') {
        setView(m.view);
        queue.current.push(...m.events);
        setTick((t) => t + 1);
      } else if (m.t === 'react') {
        throwAt(m.from, m.to, m.kind);
      } else if (m.t === 'report') {
        settlementPdf(m.report)
          .then((blob) => deliverPdf(blob, `danka-club-${m.report.code}-${new Date().toISOString().slice(0, 10)}.pdf`))
          .then(() => toast('Settlement PDF ready'))
          .catch(() => toast('Could not make the PDF. Try again.'))
          .finally(() => setExporting(false));
      } else if (m.t === 'error' && viewRef.current) {
        play('error'); buzz(HAP.error); toast(m.message);
        if (m.code === 'need_loan' || m.code === 'need_player_loan') setSheet('loan');
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
    const name = (i: number) => (i === you ? 'You' : v.players[i]?.name ?? '');
    let sawShow = false;
    for (const e of evs) {
      switch (e.e) {
        case 'joined': if (!e.rejoined && e.seat !== you) { play('knock'); buzz(HAP.land); toast(`${e.name} joined the table`); } break;
        case 'left': toast(`${e.name} left the table`); break;
        case 'period': play('gong'); buzz(HAP.rise); showBanner({ kind: 'round', title: `${Math.max(1, Math.round((e.endsAt - Date.now()) / 60000))} minutes`, sub: `Period ${e.round} · Placecut when the clock runs out` }, 2200); break;
        case 'start': play('chime'); setSheet((s) => (s === 'result' ? null : s)); break;
        case 'game': if (e.wellCutGame && e.wellCutGame > 1) { play('chime'); showBanner({ kind: 'wellcut', title: `Well Cut · game ${e.wellCutGame} of 4`, sub: `${e.cardsEach} card${e.cardsEach === 1 ? '' : 's'} each` }, 2200); } break;
        case 'commit': shuffleDeck(); play('shuffle'); break;
        case 'cut': {
          // hold the bar on screen, frozen where it stopped, with the hidden target revealed
          setFrozen({ pos: e.pos, off: e.off, wellCut: e.wellCut, zone: v.rules.wellCutZone, auto: e.auto });
          clearTimeout(frozenTimer.current);
          frozenTimer.current = window.setTimeout(() => setFrozen(null), e.wellCut ? 3600 : 2400);
          play('stop');
          if (e.wellCut) {
            // celebrate out of the bar itself, so everyone can still see where the slider stopped
            setTimeout(() => {
              play('fanfare', true); buzz(HAP.win);
              const c = centerOf(document.querySelector('.cutbar-panel .cb-mid'));
              burst(c, ['#F4A300', '#FFF6DD', '#2FBF71', '#5BE39A', '#C8963E'], 34);
              setTimeout(() => burst(c, ['#F4A300', '#FFF6DD', '#2FBF71'], 22), 260);
            }, 300);
          } else {
            setTimeout(() => { play('lose'); buzz(HAP.thud); }, 250);
          }
          break;
        }
        case 'deal': {
          // §4 One card to each player, starting on the dealer's left; then the second round, third, and fourth after a Well Cut.
          setDealing(true); setLanded(0);
          const per = settings.reduce ? 25 : 150, gap = settings.reduce ? 60 : 420, fly1 = 260;
          let t = 0;
          for (let r = 0; r < e.cardsEach; r++) {
            const start = t;
            setTimeout(() => { setDealRound({ r: r + 1, of: e.cardsEach }); play('tick'); }, start);
            e.order.forEach((s, k) => {
              const delay = start + k * per;
              const target = s === you ? centerOf(document.querySelectorAll('#my-cards .pc')[r] ?? null) : centerOf(seatMinis(s));
              setTimeout(() => play('flick'), delay);
              fly('fly-card back', '', centerOf(deckEl()), target, fly1, { delay, arc: 26, spin: s === you ? 0 : 200, s1: s === you ? 1.6 : 0.7 })
                .then(() => { play('land'); if (s === you) buzz(HAP.land); });
            });
            t = start + e.order.length * per + fly1;
            setTimeout(() => setLanded(r + 1), t);
            t += gap;
          }
          setTimeout(() => { setDealing(false); setDealRound(null); }, t);
          break;
        }
        case 'turn': if (e.seat === you) { play('chime'); buzz(HAP.turn); } break;
        case 'see':
          if (e.seat !== you) { bubble(e.seat, e.auto ? 'Shown!' : 'Seen'); play('creak'); }
          else if (e.auto) { play('creak'); buzz(HAP.peek); toast('Your 3 extra Blinds are used up, so your cards are shown'); }
          break;
        case 'bet':
          chip(centerOf(seatAvatar(e.seat)), centerOf(potEl()));
          play('clink', e.amount);
          bubble(e.seat, `${BET_LABEL[e.kind]} ${e.amount}`);
          if (e.seat === you) buzz(HAP.click);
          break;
        case 'pack': play('thud'); bubble(e.seat, e.reason === 'timeout' ? 'Time up' : 'Pack'); if (e.seat === you) { buzz(HAP.thud); if (e.reason === 'timeout') toast('Time ran out, so you packed'); } break;
        case 'sideshow': {
          play('drum'); buzz(e.from === you || e.to === you ? HAP.drum : HAP.tick);
          const winner = e.loser === e.from ? e.to : e.from;
          bubble(e.loser, 'Folded');
          toast(e.loser === you ? `Sideshow with ${name(winner)}: their hand is stronger. You fold.`
            : winner === you ? `Sideshow with ${name(e.loser)}: your hand is stronger. They fold.`
            : `${name(e.from)} asked ${name(e.to)} for a sideshow. ${name(e.loser)} folds.`);
          break;
        }
        case 'show':
          sawShow = true;
          setShowing(true); play('drum'); buzz(HAP.drum);
          setTimeout(() => setShowing(false), settings.reduce ? 1500 : 3400);
          break;
        case 'win': {
          const delay = sawShow ? (settings.reduce ? 1200 : 3000) : 300;
          const w = e.seat, iWon = w === you;
          setTimeout(() => {
            const to = centerOf(seatAvatar(w)), from = centerOf(potEl());
            for (let k = 0; k < 9; k++) chip(from && { x: from.x + (Math.random() * 20 - 10), y: from.y }, to, k * 55);
            play('cascade');
            setTimeout(() => { burst(to, ['#F4A300', '#FFF6DD', '#C8963E', '#2FBF71'], 16); play('fanfare', iWon && e.pot >= 40); if (iWon) buzz(HAP.win); }, 650);
          }, delay);
          setTimeout(() => setSheet((s) => (s === null ? 'result' : s)), delay + 1400);
          break;
        }
        case 'bonus': {
          const d = sawShow ? 3200 : 700;
          setTimeout(() => {
            play('fanfare', true); buzz(HAP.win);
            showBanner({ kind: 'bonus', title: e.kind === 'quad' ? 'FOUR OF A KIND!' : 'THREE OF A KIND!', sub: `${name(e.seat)} ${e.seat === you ? 'get' : 'gets'} ${e.each} from each player · +${e.total}` }, 3200);
            const to = centerOf(seatAvatar(e.seat));
            v.players.forEach((_, i) => { if (i !== e.seat) chip(centerOf(seatAvatar(i)), to, i * 70); });
          }, d);
          break;
        }
        case 'loan': if (e.seat === you) { play('clink', 3); toast(`Bank loan: +${e.amount} coins`); } else bubble(e.seat, `Bank +${e.amount}`); break;
        case 'sitout': if (e.seat === you) { play('lose'); toast('No coins left: you sit this game out. Borrow from a player to come back in.'); } break;
        case 'p2p_request':
          if (e.to === you) { play('knock'); buzz(HAP.turn); setSheet('lend'); }
          else if (e.from === you) toast(`Asked ${name(e.to)} for ${e.amount} coins. Waiting for an answer…`);
          break;
        case 'p2p_answer':
          if (e.from === you) {
            if (e.accepted) { play('clink', 4); buzz(HAP.win); toast(`${name(e.to)} lent you ${e.amount} coins`); setSheet((s) => (s === 'loan' ? null : s)); }
            else { play('error'); buzz(HAP.error); toast(`${name(e.to)} declined. You can ask someone else.`); }
          } else if (e.accepted && e.to !== you) bubble(e.from, `Loan +${e.amount}`);
          break;
        case 'p2p_cancel': if (e.to === you) setSheet((s) => (s === 'lend' ? null : s)); break;
        case 'placecut': play('gong'); buzz(HAP.rise); setSheet(null); break;
        case 'ended': play('fanfare'); setSheet(null); break;
        case 'timer': toast(`The admin switched the turn timer ${e.on ? 'on' : 'off'}`); break;
        case 'call_off': toast('The admin called off the session. It ends after this game.'); break;
        case 'table_size': play('tick'); break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // close the result sheet when the next game starts
  useEffect(() => {
    if (view && view.phase !== 'game_over' && sheet === 'result') { setSheet(null); setVerify(null); }
  }, [view?.phase, view, sheet]);

  // offer the bank automatically when it is your turn and you are short
  const needed = view?.options.loan?.needed ?? 0;
  useEffect(() => { if (needed > 0) setSheet((s) => (s === null ? 'loan' : s)); }, [needed]);
  // a loan request waiting for my answer
  const incoming = view?.incoming.length ?? 0;
  useEffect(() => { if (incoming > 0) setSheet((s) => (s === null || s === 'result' ? 'lend' : s)); }, [incoming]);

  /* ---------- turn timer ring (only when the admin has switched the timer on) ---------- */
  useEffect(() => {
    if (!view || view.phase !== 'betting' || view.deadline?.kind !== 'turn' || view.turn < 0) return;
    const C = 2 * Math.PI * 28, total = view.rules.turnSeconds * 1000, at = view.deadline.at, turn = view.turn, you = view.you;
    let raf = 0, lastSec = -1;
    const loop = () => {
      const fg = document.querySelector(`[data-seat="${turn}"] .ring .fg`) as SVGCircleElement | null;
      const rem = Math.max(0, at - (client.current?.serverNow() ?? Date.now()));
      if (fg) { fg.style.strokeDasharray = String(C); fg.style.strokeDashoffset = String(C * (1 - rem / total)); fg.classList.toggle('low', rem < 5000); }
      if (turn === you && rem < 5000 && rem > 0) { const s = Math.ceil(rem / 1000); if (s !== lastSec) { lastSec = s; play('tick'); buzz(HAP.tick); } }
      if (rem > 0) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      const fg = document.querySelector(`[data-seat="${turn}"] .ring .fg`) as SVGCircleElement | null;
      if (fg) { fg.style.strokeDasharray = ''; fg.style.strokeDashoffset = ''; }
    };
  }, [view?.turn, view?.deadline?.at, view?.deadline?.kind, view?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (v && to === v.you && from !== v.you) { buzz(HAP.wobble); toast(`${v.players[from]?.name} threw a ${t.label.toLowerCase()} at you`); }
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
  const offlineBanner = status === 'reconnecting' || quality.q === 'offline'
    ? <div className="status-banner">{navigator.onLine ? 'Connection lost. Reconnecting… your seat is held.' : 'No internet. Your seat is held; you will rejoin automatically.'}</div> : null;
  const exportPdf = () => { if (exporting) return; setExporting(true); play('tap'); send.send({ t: 'report' }); setTimeout(() => setExporting(false), 15000); };
  const adminSheet = (
    <>
      <div className={`scrim${sheet === 'admin' || sheet === 'lend' || (sheet === 'loan' && view.phase !== 'betting') ? ' on' : ''}`} onClick={() => setSheet(null)} />
      <AdminSheet open={sheet === 'admin'} view={view} client={send} exporting={exporting} onExport={exportPdf} onClose={() => setSheet(null)} />
      <LendSheet open={sheet === 'lend'} view={view} client={send} onClose={() => setSheet(null)} />
      {(view.phase === 'placecut' || view.phase === 'lobby') && <LoanSheet open={sheet === 'loan'} view={view} client={send} onClose={() => setSheet(null)} />}
    </>
  );

  if (view.phase === 'lobby') return <><Lobby view={view} code={code} client={send} toast={toast} onExit={onExit} onSettings={onSettings} onAdmin={() => setSheet('admin')} />{adminSheet}{offlineBanner}</>;
  if (view.phase === 'placecut' || view.phase === 'ended') {
    return <><Placecut view={view} code={code} client={send} toast={toast} exporting={exporting} onExport={exportPdf} onExit={onExit} onSettings={onSettings} onAdmin={() => setSheet('admin')} onBorrow={() => setSheet('loan')} />{adminSheet}{offlineBanner}</>;
  }

  return (
    <>
      <Table view={view} code={code} client={send} quality={quality} dealing={dealing} dealRound={dealRound} landed={landed} frozen={frozen} onSheet={setSheet} onReact={setReactTo} onSettings={onSettings} />
      {offlineBanner}
      {banner && <div key={banner.title + banner.sub} className={`big-banner ${banner.kind}`} role="status"><b>{banner.title}</b><span>{banner.sub}</span></div>}
      <ShowOverlay view={view} on={showing} />
      <div className={`scrim${sheet && sheet !== 'result' ? ' on' : ''}`} onClick={() => setSheet(null)} />
      <ReactMenu view={view} seat={reactTo} onClose={() => setReactTo(null)} onThrow={(kind) => { send.send({ t: 'react', to: reactTo!, kind }); setReactTo(null); }} />
      <div className={`sheet${sheet === 'ledger' ? ' on' : ''}`} role="dialog" aria-label="Ledger">
        <div className="grab" />
        <h3>Ledger <span className="fine">Coins have no cash value</span></h3>
        <div className="sheet-body">
          {[...view.ledger].reverse().map((l) => (
            <div key={l.id} className={`ledger-item ${l.type === 'pot_win' || l.type === 'bonus_in' ? 'win' : l.type === 'loan' ? 'loan' : ''}`}>
              <time>{new Date(l.at).toTimeString().slice(0, 5)}</time>
              <span><b>{l.name}</b> · {l.note ?? l.type.replace('_', ' ')}{l.amount ? ` · ${sgn(l.amount)}` : ''}</span>
              <span className="lbal num">{fmt(l.balance)}</span>
            </div>
          ))}
        </div>
      </div>
      <LoanSheet open={sheet === 'loan'} view={view} client={send} onClose={() => setSheet(null)} />
      <ResultSheet open={sheet === 'result'} view={view} client={send} verify={verify}
        onVerify={async () => {
          const r = view.result!;
          const ok = await verifyCommitment(r.commit, r.deck, r.salt);
          setVerify(ok ? 'ok' : 'bad'); play(ok ? 'chime' : 'error'); buzz(ok ? HAP.click : HAP.error);
        }} />
      <div className={`sheet${sheet === 'leave' ? ' on' : ''}`} role="dialog" aria-label="Leave table">
        <div className="grab" />
        <h3>Step away?</h3>
        <div className="confirm-body">
          <p>Your seat stays yours: open the room again with the same code to come back. Players can only leave the room for good at a settlement, after a game.
            {view.timerOn ? ' The turn timer is on, so you pack if your turn times out.' : ' The table waits for you on your turn.'}</p>
          <div className="row2"><button className="btn line" onClick={() => setSheet(null)}>Stay</button><button className="btn gold" onClick={() => onExit()}>Step away</button></div>
        </div>
      </div>
      {adminSheet}
    </>
  );
}

/* ================= LOBBY ================= */

function Lobby({ view, code, client, toast, onExit, onSettings, onAdmin }: { view: PlayerView; code: string; client: RoomClient; toast: ToastFn; onExit: (m?: string) => void; onSettings: () => void; onAdmin: () => void }) {
  const me = view.players[view.you];
  const isAdmin = view.isAdmin;
  const n = view.players.length;
  const size = view.tableSize;
  const full = n >= size;
  const setSize = (v: number) => { client.send({ t: 'size', size: v }); play('tick'); buzz(HAP.tick); };
  return (
    <section className="screen" id="lobby" aria-label="Waiting room">
      <div className="bar">
        <button className="icon-btn" aria-label="Leave waiting room" onClick={() => { if (isAdmin) onExit(); else client.send({ t: 'leave' }); }}><Icon name="back" /></button>
        <h2>Waiting room</h2>
        {isAdmin && <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="Admin controls" onClick={() => { play('tap'); onAdmin(); }}><Icon name="crown" /></button>}
        <button className="icon-btn" style={isAdmin ? undefined : { marginLeft: 'auto' }} aria-label="Settings" onClick={onSettings}><Icon name="sliders" /></button>
      </div>
      <InviteCard code={code} toast={toast} />
      <div className="lobby-status"><span>{!full ? `${size - n} seat${size - n === 1 ? '' : 's'} open` : 'Table full'}</span><b className="num">{n}/{size}</b></div>
      <div className="progress"><i style={{ width: `${(n / size) * 100}%` }} /></div>
      {isAdmin && (
        <div className="size-row">
          <span><small>Table size</small><b>{size} players</b></span>
          <span className="stepper">
            <button aria-label="One seat fewer" disabled={size <= Math.max(view.minPlayers, n)} onClick={() => setSize(size - 1)}>−</button>
            <button aria-label="One seat more" disabled={size >= view.maxPlayers} onClick={() => setSize(size + 1)}>+</button>
          </span>
        </div>
      )}
      <div className="seat-list">
        {Array.from({ length: size }, (_, i) => {
          const s = view.players[i];
          if (!s) return (
            <div key={i} className="lrow empty"><span className="ord">#{i + 1}</span>Open seat
              {isAdmin && <button className="add-bot" onClick={() => { client.send({ t: 'add_bot' }); play('tap'); buzz(HAP.tick); }}><Icon name="robot" />Add computer</button>}
            </div>
          );
          return (
            <div key={i} className="lrow pop">
              <span className="ord">#{i + 1}</span>
              <span className="lav" style={{ background: colorOf(i) }}>{ini(s.name)}</span>
              <span className="who"><b>{i === view.you ? `${s.name} (you)` : s.name}</b>
                <span className="badges">{s.isAdmin && <span className="badge">Admin</span>}{s.bot && <span className="badge cpu">Computer</span>}{s.isDealer && <span className="badge deal">Deals game 1</span>}{!s.connected && <span className="badge">Offline</span>}</span></span>
              <span className="ready ok num">{fmt(s.coins)}</span>
              {isAdmin && s.bot && <button className="rm-bot" aria-label={`Remove ${s.name}`} onClick={() => { client.send({ t: 'remove_bot', seat: i }); play('tap'); }}>×</button>}
            </div>
          );
        })}
      </div>
      <p className="rule-note">Everyone starts with {view.rules.startingCoins} coins. The admin deals game 1, then each winner deals. Every 20 minutes, after the game in progress, there is a Placecut: settlement, and players can join or leave.</p>
      <div className="lobby-actions" style={{ gridTemplateColumns: '1fr' }}>
        {isAdmin
          ? <button className="btn gold" disabled={!view.options.startGame} onClick={() => { client.send({ t: 'start_game' }); buzz(HAP.click); }}>{n < view.minPlayers ? `Waiting for players (${n}/${view.minPlayers})` : `Start 20 minutes with ${n}`}</button>
          : <button className="btn gold" disabled>{me ? 'Waiting for the admin to start' : 'Joining…'}</button>}
      </div>
    </section>
  );
}

function InviteCard({ code, toast }: { code: string; toast: ToastFn }) {
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
    <div className="room-card">
      <div><small>Room code</small><div className="room-code">{code}</div></div>
      <button className="btn line" style={{ height: 46 }} onClick={share}><Icon name="share" />Invite</button>
    </div>
  );
}

/* ================= PLACECUT / SETTLEMENT ================= */

function Placecut({ view, code, client, toast, exporting, onExport, onExit, onSettings, onAdmin, onBorrow }: {
  view: PlayerView; code: string; client: RoomClient; toast: ToastFn; exporting: boolean; onExport: () => void; onExit: (m?: string) => void; onSettings: () => void; onAdmin: () => void; onBorrow: () => void;
}) {
  const ended = view.phase === 'ended';
  const card = view.scorecard;
  const me = view.players[view.you];
  const rows = card ? [...card.rows].sort((a, b) => b.net - a.net) : [];
  const [open, setOpen] = useState<string | null>(null);
  const g = card?.results[0];
  const wcNext = false;
  return (
    <section className="screen" id="lobby" aria-label={ended ? 'Final settlement' : 'Settlement'}>
      <div className="bar">
        <button className="icon-btn" aria-label="Home" onClick={() => onExit()}><Icon name="home" /></button>
        <h2>{ended ? 'Final settlement' : `Placecut · period ${view.round}`}</h2>
        {view.isAdmin && !ended && <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="Admin controls" onClick={() => { play('tap'); onAdmin(); }}><Icon name="crown" /></button>}
        <button className="icon-btn" style={view.isAdmin && !ended ? undefined : { marginLeft: 'auto' }} aria-label="Settings" onClick={onSettings}><Icon name="sliders" /></button>
      </div>
      {g && card?.kind === 'game' && (
        <div className="last-game">
          <b>{g.winner} won {fmt(g.pot)}{g.bonus ? ` + bonus ${fmt(g.bonus)}` : ''}</b>
          <span>Game {g.game} · {g.wellCutGame ? `Well Cut ${g.wellCutGame}/4 · ` : ''}{g.cardsEach} card{g.cardsEach === 1 ? '' : 's'} · {g.reason === 'show' ? 'won at Show' : 'everyone else packed'}</span>
        </div>
      )}
      {card && (
        <div className="pc-stats">
          <div><small>Games</small><b className="num">{card.games}</b></div>
          <div><small>Total pot</small><b className="num">{fmt(card.totalPot)}</b></div>
          <div><small>Well Cuts</small><b className="num">{card.wellCuts}</b></div>
          <div><small>Bonuses</small><b className="num">{fmt(card.totalBonus)}</b></div>
          <div><small>Bank loans</small><b className="num">{fmt(card.loansIssued)}</b></div>
        </div>
      )}
      <div className="seat-list scorecard" aria-label="Scorecard">
        {rows.map((r) => (
          <button key={r.name} className={`score-row${open === r.name ? ' open' : ''}${r.eliminated ? ' out' : ''}`} onClick={() => { play('tap'); setOpen(open === r.name ? null : r.name); }}>
            <span className="sr-top">
              <span className="who"><b>{r.name}{me && r.name === me.name ? ' (you)' : ''}{r.left ? ' (left)' : ''}</b>
                <small>Balance {fmt(r.balance)}{r.periodChange ? <> · <span className={r.periodChange > 0 ? 'up' : 'down'}>{sgn(r.periodChange)} this period</span></> : ''}{r.outstandingLoan ? ` · bank ${fmt(r.outstandingLoan)}` : ''}{r.owesPlayers ? ` · owes ${fmt(r.owesPlayers)}` : ''}{r.owedByPlayers ? ` · owed ${fmt(r.owedByPlayers)}` : ''}{r.eliminated ? ' · no coins' : ''}</small></span>
              <span className={`net num ${r.net >= 0 ? 'up' : 'down'}`}>{sgn(r.net)}</span>
            </span>
            {open === r.name && (
              <span className="sr-grid num">
                <span>Games <b>{fmt(r.games)}</b></span><span>Received <b>{fmt(r.received)}</b></span><span>Paid <b>{fmt(r.paid)}</b></span>
                <span>Winnings <b>{fmt(r.winnings)}</b></span><span>Losses <b>{fmt(r.losses)}</b></span><span>Balance <b>{fmt(r.balance)}</b></span>
                <span>Initial <b>{fmt(r.initial)}</b></span><span>Bank loans <b>{fmt(r.loanTotal)}</b></span><span>Bank owed <b>{fmt(r.outstandingLoan)}</b></span>
                <span>Owes players <b>{fmt(r.owesPlayers)}</b></span><span>Owed by players <b>{fmt(r.owedByPlayers)}</b></span><span>Net <b>{sgn(r.net)}</b></span>
                <span>Bonus in <b>{fmt(r.bonusIn)}</b></span><span>Bonus out <b>{fmt(r.bonusOut)}</b></span><span>This period <b>{sgn(r.periodChange)}</b></span>
              </span>
            )}
          </button>
        ))}
        {view.p2p.length > 0 && (
          <div className="games-list p2p-list">
            <b>Player loans</b>
            {view.p2p.map((l) => <div key={l.borrower + l.lender} className="ledger-item"><span><b>{l.borrowerName}</b> owes <b>{l.lenderName}</b></span><span className="lbal num">{fmt(l.amount)}</span></div>)}
          </div>
        )}
        {view.history.length > 0 && (
          <details className="games-list">
            <summary>Game by game ({view.history.length > 29 ? 'latest 30' : view.history.length})</summary>
            {[...view.history].reverse().map((h) => (
              <div key={h.game} className="ledger-item"><time>#{h.game}</time>
                <span>{h.winner} won {fmt(h.pot)}{h.bonus ? ` + bonus ${h.bonus}` : ''} · {h.wellCutGame ? `Well Cut ${h.wellCutGame}/4 · ` : ''}{h.cardsEach} cards · {h.reason === 'show' ? 'Show' : 'others packed'}</span></div>
            ))}
          </details>
        )}
      </div>
      <p className="rule-note">{ended ? 'The tournament is over. Net = balance − 100 starting coins − bank loan − owed to players + owed by players. Coins have no cash value.'
        : wcNext ? `Well Cut game ${view.wellCut.game} of 4 is next. Nobody joins or leaves until the four Well Cut games are done.`
        : 'Placecut is only a break: nothing resets. Balances, loans and totals carry into the next 20 minutes. New players can join now, and anyone can leave.'}</p>
      {!ended && !wcNext && <InviteCard code={code} toast={toast} />}
      {!ended && view.options.borrow && (
        <button className="btn line borrow-cta" onClick={() => { play('tap'); onBorrow(); }}><Icon name="bank" />{view.myRequest ? `Waiting for ${view.players[view.myRequest.to]?.name}…` : 'Borrow from a player'}</button>
      )}
      <div className="lobby-actions" style={{ gridTemplateColumns: view.isAdmin ? '1fr 1.4fr' : '1fr' }}>
        {view.isAdmin
          ? <>
            <button className="btn line" disabled={exporting} onClick={onExport}><Icon name="file" />{exporting ? 'Making PDF…' : 'Export PDF'}</button>
            {ended
              ? <button className="btn gold" onClick={() => onExit()}>Back to home</button>
              : <button className="btn gold" disabled={!view.options.startGame} onClick={() => { client.send({ t: 'start_game' }); buzz(HAP.click); }}>Start next 20 minutes</button>}
          </>
          : ended
            ? <button className="btn gold" onClick={() => onExit()}>Back to home</button>
            : <button className="btn line" disabled={!view.options.leave} onClick={() => { client.send({ t: 'leave' }); }}>{wcNext ? 'Leave after the Well Cut' : 'Leave the room'}</button>}
      </div>
    </section>
  );
}

/* ================= ADMIN ================= */

function AdminSheet({ open, view, client, exporting, onExport, onClose }: { open: boolean; view: PlayerView; client: RoomClient; exporting: boolean; onExport: () => void; onClose: () => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!open) setConfirm(false); }, [open]);
  if (!view.isAdmin) return null;
  const between = view.phase === 'lobby' || view.phase === 'placecut';
  return (
    <div className={`sheet${open ? ' on' : ''}`} role="dialog" aria-label="Admin controls">
      <div className="grab" />
      <h3>Admin controls</h3>
      <div className="sheet-body set-group on">
        <div className="set-row">
          <span className="lbl"><b>Turn timer</b><small>{view.timerOn ? `On: ${view.rules.turnSeconds} s per turn; time out = pack. The dealer’s cut and deal are timed too.` : 'Off: the table waits for each player, like at home.'}</small></span>
          <button className="switch" role="switch" aria-checked={view.timerOn} aria-label="Turn timer" onClick={() => { client.send({ t: 'timer', on: !view.timerOn }); play('tick'); buzz(HAP.tick); }} />
        </div>
        {between && (
          <div className="set-row">
            <span className="lbl"><b>Table size</b><small>{view.players.length} seated</small></span>
            <span className="stepper">
              <button aria-label="One seat fewer" disabled={view.tableSize <= Math.max(view.minPlayers, view.players.length)} onClick={() => client.send({ t: 'size', size: view.tableSize - 1 })}>−</button>
              <b className="num" style={{ alignSelf: 'center', minWidth: 22, textAlign: 'center' }}>{view.tableSize}</b>
              <button aria-label="One seat more" disabled={view.tableSize >= view.maxPlayers} onClick={() => client.send({ t: 'size', size: view.tableSize + 1 })}>+</button>
            </span>
          </div>
        )}
        {view.options.tableSize && (
          <div className="set-row">
            <span className="lbl"><b>Computer players</b><small>{view.players.filter((p) => p.bot).length} at the table. Add one to fill a seat; remove them in the waiting room.</small></span>
            <button className="btn line" style={{ height: 40 }} disabled={view.players.length >= view.maxPlayers} onClick={() => { client.send({ t: 'add_bot' }); play('tap'); }}><Icon name="robot" />Add</button>
          </div>
        )}
        <div className="set-row">
          <span className="lbl"><b>Settlement PDF</b><small>Every round’s scorecard and the complete ledger.</small></span>
          <button className="btn line" style={{ height: 40 }} disabled={exporting || view.round === 0} onClick={onExport}><Icon name="file" />{exporting ? '…' : 'Export'}</button>
        </div>
        <div className="set-row col">
          <span className="lbl"><b>Call off the session</b><small>{view.callOff ? 'Called off: the session ends after the current game.' : between ? 'Ends the night now and shows the final settlement.' : 'The current game finishes first, then the final settlement is shown.'}</small></span>
          {view.options.callOff && (confirm
            ? <div className="row2"><button className="btn line" onClick={() => setConfirm(false)}>Keep playing</button>
              <button className="btn gold" style={{ background: 'linear-gradient(135deg,#E5484D,#A32A2E)', color: '#fff' }} onClick={() => { client.send({ t: 'call_off' }); onClose(); buzz(HAP.thud); }}>Call it off</button></div>
            : <button className="btn line" style={{ color: '#FF9A9D' }} onClick={() => { setConfirm(true); buzz(HAP.tick); }}>Call off…</button>)}
        </div>
        <p className="note">The admin cannot see anyone’s cards, change the shuffle or edit balances. Every admin action is written in the ledger.</p>
      </div>
    </div>
  );
}

/* ================= TABLE ================= */

function Table({ view, code, client, quality, dealing, dealRound, landed, frozen, onSheet, onReact, onSettings }: { view: PlayerView; code: string; client: RoomClient; quality: { q: Quality; rtt: number }; dealing: boolean; dealRound: { r: number; of: number } | null; landed: number; frozen: Frozen; onSheet: (s: Sheet) => void; onReact: (seat: number) => void; onSettings: () => void }) {
  useTicker(1000);
  const you = view.you, n = view.players.length;
  const me = view.players[you];
  const cardsVisible = (view.phase === 'betting' || view.phase === 'game_over') && !dealing;
  const o = view.options;
  const dealerBtn = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const now = client.serverNow();

  // slide the dealer button next to the dealer
  useLayoutEffect(() => {
    const d = dealerBtn.current, a = area.current?.getBoundingClientRect(), av = document.querySelector(`[data-seat="${view.dealer}"] .av`)?.getBoundingClientRect();
    if (!d || !a || !av) return;
    let x = av.left - a.left + av.width / 2, y = av.top - a.top + av.height / 2;
    const k = (view.dealer - you + n) % n;
    if (k === 0) { x += 34; y -= 30; } else if (posFor(k, n)?.s !== 'sr') { x += 30; y += 22; } else { x -= 30; y += 22; }
    d.style.left = `${x}px`; d.style.top = `${y}px`;
  }, [view.dealer, you, n]);

  // Lock the bet buttons from the tap until the server confirms, so a double tap can't send two bets.
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [view]);
  useEffect(() => { if (!busy) return; const t = setTimeout(() => setBusy(false), 4000); return () => clearTimeout(t); }, [busy]);
  const bet = (type: 'pack' | 'blind' | 'seen' | 'show' | 'sideshow' | 'see') => {
    if (busy && type !== 'see') return;
    if (type !== 'see') setBusy(true);
    client.act({ type });
  };

  const dl = view.deadline && view.deadline.kind !== 'next_game' ? Math.max(0, Math.ceil((view.deadline.at - now) / 1000)) : null;
  const left = view.roundEndsAt ? view.roundEndsAt - now : 0;
  const clock = view.roundEndsAt === null ? '—' : left > 0 ? mmss(left) : view.wellCut.active ? 'Well Cut' : 'Last game';
  const dealerName = view.players[view.dealer]?.name ?? '';
  const cutterName = view.players[view.cutter]?.name ?? '';
  const turnP = view.players[view.turn];
  const loanNeed = o.loan?.needed ?? 0;
  const xb = me?.extraBlindsLeft;
  const sideTarget = o.sideshow ? view.players[o.sideshow.target]?.name : '';

  const status =
    view.phase === 'shuffling' ? 'Shuffling a fresh deck…'
    : view.phase === 'cutting' ? (o.cut ? `You cut for ${dealerName}. Tap STOP when the slider is on the gold line${dl !== null ? ` · ${dl}` : ''}.` : `${cutterName} is cutting for ${dealerName}. The gold line is a Well Cut.`)
    : view.phase === 'dealing' ? (o.deal ? `Tap the deck to deal ${view.cardsEach} card${view.cardsEach === 1 ? '' : 's'} each${dl !== null ? ` · ${dl}` : ''}.` : `${dealerName} is dealing`)
    : view.phase === 'betting' ? (
      !me ? ''
      : me.status === 'eliminated' ? (view.options.borrow ? 'No coins left: you sit this game out. Borrow from a player to play the next one.' : 'You sit this game out.')
      : me.status === 'packed' ? 'You packed. Watching the rest of the game.'
      : view.turn === you ? (loanNeed > 0 ? `You need ${loanNeed} more coin${loanNeed === 1 ? '' : 's'}. Borrow from the bank or pack.`
        : view.options.borrow && me.coins < (me.seen || o.mustSeen ? view.rules.seen : view.rules.blind) ? (view.myRequest ? `Waiting for ${view.players[view.myRequest.to]?.name} to answer your loan request…` : 'Your bank loan is used up. Borrow from a player, or pack.')
        : o.mustSeen ? `${view.players[view.lastBlind ?? -1]?.name ?? 'The player before you'} played Blind, so you must play Seen (${view.rules.seen} coins) or pack.`
        : `Your turn · ${me.seen ? `Seen: ${view.rules.seen} coins` : `Blind: ${view.rules.blind} coin`}${xb !== null && xb !== undefined && !me.seen ? ` · ${xb} Blind turn${xb === 1 ? '' : 's'} left, then your cards are shown` : ''}`)
      : turnP?.connected === false ? `${turnP.name} is offline. ${view.timerOn ? 'They pack if the timer runs out.' : 'The admin can switch on the turn timer.'}`
      : `${turnP?.name ?? ''} is thinking…`)
    : view.phase === 'game_over' && view.result ? `${view.result.winner === you ? 'You win' : `${view.players[view.result.winner]?.name} wins`} ${fmt(view.result.pot)}`
    : '';

  return (
    <section className="screen" id="table" aria-label="Card table">
      <div className="topbar">
        <button className="icon-btn" aria-label="Step away" onClick={() => { play('tap'); onSheet('leave'); }}><Icon name="home" /></button>
        <span className="room-chip">{code}</span>
        <span className="hand-no num"><span className={`clock${left > 0 && left < 120_000 ? ' low' : ''}`}><Icon name="clock" />{clock}</span> G{view.game}</span>
        <span className={`signal ${quality.q}`} role="img" aria-label={quality.q === 'offline' ? 'Offline' : `Connection ${quality.q}, ${Math.round(quality.rtt)} ms`} title={quality.q === 'offline' ? 'Offline' : `${Math.round(quality.rtt)} ms`}><i /><i /><i /></span>
        <button className="icon-btn" aria-label="Ledger" onClick={() => { play('tap'); onSheet('ledger'); }}><Icon name="ledger" /></button>
        {view.isAdmin
          ? <button className={`icon-btn${view.callOff ? ' on' : ''}`} aria-label="Admin controls" onClick={() => { play('tap'); onSheet('admin'); }}><Icon name="crown" /></button>
          : <button className="icon-btn" aria-label="Settings" onClick={onSettings}><Icon name="sliders" /></button>}
      </div>
      <div id="table-area" ref={area} className={n > 7 ? 'many' : undefined}>
        <div className="felt" />
        <div className="center">
          <div id="deck" role="button" aria-label={o.deal ? 'Tap to deal' : 'Deck'} className={o.deal ? 'pulse' : ''} onClick={() => { if (o.deal) { client.send({ t: 'deal' }); buzz(HAP.click); } }}>
            <div className="dk back" /><div className="dk back" /><div className="dk back" />
          </div>
          <div className="fp num">{view.commit ? `Fingerprint ${view.commit.slice(0, 8)}` : 'Fingerprint ········'}</div>
          <div className="deal-prompt">{dealRound ? <span className="deal-round" key={dealRound.r}>{['1st', '2nd', '3rd', '4th'][dealRound.r - 1]} card · round {dealRound.r} of {dealRound.of}</span> : o.deal ? 'Tap to deal' : ''}</div>
          <div className="pot"><small>POT</small><b className="num">{fmt(view.pot)}</b></div>
          <div className="stake num">Blind {view.rules.blind} · Seen {view.rules.seen}</div>
          {view.wellCut.active && <div className="wc-chip">WELL CUT · {view.wellCut.game}/4 · {view.cardsEach} card{view.cardsEach === 1 ? '' : 's'}</div>}
          {view.callOff && <div className="mode-info">Last game: called off</div>}
        </div>
        {view.players.map((s, i) => {
          if (i === you) return null;
          const k = (i - you + n) % n, pos = posFor(k, n);
          if (!pos) return null;
          const cls = ['seat', pos.s, view.turn === i && view.phase === 'betting' ? 'turn' : '', s.status === 'packed' ? 'packed' : '', s.status === 'eliminated' ? 'packed out' : '', s.seen && s.status === 'in' ? 'seen-st' : ''].join(' ');
          return (
            <div key={i} className={cls} data-seat={i} style={{ left: `${pos.x}%`, top: `${pos.y}%` }}>
              <div className="av-wrap">
                <svg className="ring" viewBox="0 0 60 60"><circle className="bg" cx="30" cy="30" r="28" /><circle className="fg" cx="30" cy="30" r="28" /></svg>
                <button className="av" style={{ background: colorOf(i) }} aria-label={`${s.name}: throw something`} onClick={() => { play('tap'); buzz(HAP.tick); onReact(i); }}>{ini(s.name)}</button>
                <span className={`dot${s.connected ? '' : ' amber'}`} />
                {s.bot && <span className="cpu-badge" aria-label="Computer player">CPU</span>}
                <div className="bubble" />
                <div className="minis">{(cardsVisible || dealing) && s.status !== 'eliminated' && Array.from({ length: dealing ? Math.min(s.cardCount, landed) : s.cardCount }, (_, c) => <div key={c} className="mini back" />)}</div>
              </div>
              <div className="nm">{s.name}</div>
              <div className="co num">{fmt(s.coins)}{s.loan ? <span className="owe"> −{s.loan}</span> : null}</div>
              <Tag s={s} />
            </div>
          );
        })}
        <div id="dealer-btn" ref={dealerBtn}>D</div>
        {(view.cutBar || frozen) && (
          <CutBarPanel bar={view.cutBar} frozen={frozen} isCutter={!!o.cut} cutterName={cutterName} dealerName={dealerName} serverNow={client.serverNow}
            onStop={() => { client.send({ t: 'cut', at: client.serverNow() }); }} />
        )}
      </div>
      <div className={`me${view.turn === you && view.phase === 'betting' ? ' turn' : ''}${me && me.status !== 'in' ? ' packed' : ''}`} id="me" data-seat={you}>
        <div className="me-left">
          <div className="av-wrap">
            <svg className="ring" viewBox="0 0 60 60"><circle className="bg" cx="30" cy="30" r="28" /><circle className="fg" cx="30" cy="30" r="28" /></svg>
            <div className="av">{ini(me?.name ?? '')}</div><span className="dot" /><div className="bubble" />
          </div>
          <div className="co num">{fmt(me?.coins ?? 0)}</div>
          {me && <Tag s={me} />}
        </div>
        <MyCards view={view} visible={cardsVisible} landed={dealing ? landed : -1} onSee={() => { if (o.see) bet('see'); }} />
        <div className="me-right">
          <div className="hand-name">{view.yourHand ?? ''}</div>
          <div className="squeeze-hint">{!cardsVisible || !me ? '' : me.seen ? 'You are Seen' : me.status === 'in' ? 'Drag up on your cards to squeeze' : ''}</div>
          {o.loan && <button className="bank-btn" onClick={() => { play('tap'); onSheet('loan'); }}><Icon name="bank" />{me?.loan ? `Owe ${fmt(me.loan)}` : 'Bank'}</button>}
        </div>
      </div>
      <div className="actions">
        <div className="status-line">{dealing && dealRound ? `${dealerName === me?.name ? 'You are' : `${dealerName} is`} dealing · ${['1st', '2nd', '3rd', '4th'][dealRound.r - 1]} card to everyone` : status}</div>
        {view.phase === 'game_over' && view.isAdmin && !view.callOff ? (
          <div className="abtns">
            <button className="ab cut-stop" style={{ fontSize: 20 }} onClick={() => { client.send({ t: 'start_game' }); buzz(HAP.click); }}>{o.placecutDue ? 'GO TO PLACECUT' : 'NEXT GAME'}</button>
          </div>
        ) : o.cut ? (
          <div className="abtns">
            <button className="ab cut-stop" onPointerDown={(e) => { e.preventDefault(); window.dispatchEvent(new Event('danka-stop')); }}>STOP</button>
          </div>
        ) : (
        <div className={`abtns${dealing ? ' locked' : ''}`}>
          <button className="ab pack" disabled={!o.pack || busy} onClick={() => bet('pack')}>Pack<small>fold</small></button>
          {me && !me.seen && <button className="ab see" disabled={!o.see} onClick={() => bet('see')}>See<small>cards</small></button>}
          {loanNeed > 0 || (view.turn === you && view.options.borrow && (me?.coins ?? 0) < (me?.seen || o.mustSeen ? view.rules.seen : view.rules.blind))
            ? <button className="ab chaal" onClick={() => { play('tap'); onSheet('loan'); }}><span>Borrow</span><small>{loanNeed > 0 ? `need ${loanNeed}` : 'from a player'}</small></button>
            : <button className={`ab chaal${o.mustSeen ? ' must' : ''}`} disabled={!(o.blind || o.seen) || busy} onClick={() => bet(o.blind ? 'blind' : 'seen')}>
              <span>{o.blind ? 'Blind' : 'Seen'}</span><small className="num">{o.mustSeen ? `must · ${view.rules.seen} coins` : o.blind ? `${view.rules.blind} coin` : `${view.rules.seen} coins`}</small></button>}
          {o.sideshow && <button className="ab raise" disabled={busy} onClick={() => bet('sideshow')}>Sideshow<small className="num">{o.sideshow.cost} · {sideTarget}</small></button>}
          {o.show !== null && <button className="ab show" disabled={busy} onClick={() => bet('show')}>Show<small className="num">{o.show}</small></button>}
        </div>
        )}
      </div>
    </section>
  );
}

function Tag({ s }: { s: PlayerView['players'][number] }) {
  if (s.status === 'eliminated') return <span className="tag out">Sitting out</span>;
  if (s.status === 'packed') return <span className="tag packed">Packed</span>;
  if (s.seen) return <span className="tag seen"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>Seen</span>;
  return (
    <span className="tag blind"><svg viewBox="0 0 24 24"><path d="M2 12s4-6 10-6 10 6 10 6M4 15l2-2M20 15l-2-2M12 17v-3" /></svg>Blind
      {s.extraBlindsLeft !== null && <b className="xb" title="Blind turns left before the cards are shown">{s.extraBlindsLeft}</b>}</span>
  );
}

/* ---------- §5 the Well Cut timing bar: the same slider on every phone; only the dealer can stop it ---------- */
function CutBarPanel({ bar, frozen, isCutter, cutterName, dealerName, serverNow, onStop }: {
  bar: CutBar | null; frozen: Frozen; isCutter: boolean; cutterName: string; dealerName: string; serverNow: () => number; onStop: () => void;
}) {
  const isDealer = isCutter; // the player on the dealer's left stops the slider (rules §4/§5)
  const needle = useRef<HTMLDivElement>(null);
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const [ready, setReady] = useState(true);
  const live = !!bar && !frozen && stoppedAt === null;

  // a new bar (a new cut) clears the local stop
  useEffect(() => { setStoppedAt(null); }, [bar?.startAt]);

  useEffect(() => {
    if (!live || !bar) return;
    let raf = 0, lastTick = -1, lastPass = -1;
    const loop = () => {
      const now = serverNow();
      const waiting = now < bar.startAt;
      setReady((r) => (r === waiting ? r : waiting));
      const p = barPosition(bar, now);
      if (needle.current) needle.current.style.top = `${(p * 100).toFixed(3)}%`;
      if (!waiting) {
        const k = Math.floor(p * 20);
        if (k !== lastTick) { lastTick = k; if (isDealer) play('tick'); }
        const pass = p > 0.97 || p < 0.03 ? Math.round(p) : -1;
        if (pass !== -1 && pass !== lastPass) { lastPass = pass; if (isDealer) buzz(HAP.peek); }
        if (pass === -1) lastPass = -1;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [live, bar, isDealer, serverNow]);

  // the dealer's STOP: the button in the action bar, a tap on the panel, or Space
  useEffect(() => {
    if (!live || !isDealer || !bar) return;
    const stop = () => {
      const now = serverNow();
      if (now < bar.startAt) return;
      setStoppedAt(barPosition(bar, now));
      buzz(HAP.click);
      onStop();
    };
    const key = (e: KeyboardEvent) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); stop(); } };
    window.addEventListener('danka-stop', stop);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('danka-stop', stop); window.removeEventListener('keydown', key); };
  }, [live, isDealer, bar, serverNow, onStop]);

  const pos = frozen ? frozen.pos : stoppedAt;
  useLayoutEffect(() => { if (pos !== null && needle.current) needle.current.style.top = `${(pos * 100).toFixed(3)}%`; }, [pos]);
  const zone = frozen?.zone ?? bar?.zone ?? 1.5;
  const title = frozen
    ? (frozen.wellCut ? (frozen.off <= 0.4 ? 'PERFECT!' : 'WELL CUT!') : frozen.off - zone < 2 ? 'SO CLOSE!' : 'NO WELL CUT')
    : stoppedAt !== null ? 'STOPPED…' : ready ? 'GET READY' : isDealer ? 'STOP ON THE LINE' : `${cutterName.toUpperCase()} IS CUTTING`;
  const sub = frozen
    ? (frozen.wellCut ? `4 games: 4, 3, 2, 1 cards · ${dealerName} deals` : `Missed by ${(frozen.off - zone).toFixed(1)}% · ${dealerName} deals${frozen.auto ? ' (timer)' : ''}`)
    : isDealer ? `You cut for ${dealerName}` : `Then ${dealerName} deals`;

  return (
    <div className={`cutbar-panel${frozen ? (frozen.wellCut ? ' won' : ' missed') : ''}`} role="group" aria-label="Well Cut timing bar"
      onPointerDown={(e) => { if (isDealer && live) { e.preventDefault(); window.dispatchEvent(new Event('danka-stop')); } }}>
      <div className="cb-title">{title}</div>
      <div className="cb-bar">
        <div className="cb-ticks" />
        <div className={`cb-zone${frozen ? ' show' : ''}`} style={{ height: `${zone * 2}%` }} />
        <div className="cb-mid" />
        <div className={`cb-needle${live ? '' : ' still'}`} ref={needle}><span className="l" /><span className="r" /></div>
      </div>
      <div className="cb-sub">{sub}</div>
    </div>
  );
}

/* ---------- my cards: squeeze or double-tap to see ---------- */
function MyCards({ view, visible, landed, onSee }: { view: PlayerView; visible: boolean; landed: number; onSee: () => void }) {
  const me = view.players[view.you];
  const cards = me?.cards ?? [];
  const count = Math.max(cards.length, view.cardsEach || 3);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; p: number; step: number; lastTap: number }>({ y0: NaN, p: 0, step: 0, lastTap: 0 });
  const seen = !!me?.seen;

  const flips = () => Array.from(area.current?.querySelectorAll<HTMLElement>('.flip') ?? []);
  useEffect(() => { if (seen) flips().forEach((f) => { f.classList.remove('dragging'); f.style.transform = ''; }); }, [seen]);

  const down = (e: React.PointerEvent) => {
    if (!visible || !cards.length || me?.status !== 'in') return;
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
    <div id="my-cards" ref={area} className={`n${count}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      aria-label="Your cards. Drag up to squeeze or double-tap to see them.">
      {Array.from({ length: count }, (_, k) => (
        <div key={k} className={`pc${(visible || k < landed) && cards[k] ? '' : ' empty'}`}>
          <div className={`flip${seen ? ' up' : ''}`}>
            {cards[k] && <CardFace code={cards[k]} />}
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
      <b>{seat === view.you ? 'You' : view.players[seat]?.name}</b>
      <div className="sh-cards">{cards.map((c) => <div key={c} className="pc2"><div className={`flip${flipped ? ' up' : ''}`}><CardFace code={c} /><div className="bk back" /></div></div>)}</div>
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
            {side(sh.a, sh.aCards, sh.aHand.name)}
            {side(sh.b, sh.bCards, sh.bHand.name)}
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- game result ---------- */
function ResultSheet({ open, view, client, verify, onVerify }: { open: boolean; view: PlayerView; client: RoomClient; verify: string | null; onVerify: () => void }) {
  useTicker(1000, open);
  const me = view.players[view.you];
  const r = view.result;
  if (!r) return <div className="sheet" id="result" />;
  const w = view.players[r.winner];
  const left = view.deadline?.kind === 'next_game' ? Math.max(0, Math.ceil((view.deadline.at - client.serverNow()) / 1000)) : 0;
  const wh = r.show ? (r.winner === r.show.a ? r.show.aHand : r.show.bHand) : null;
  const lh = r.show ? (r.winner === r.show.a ? r.show.bHand : r.show.aHand) : null;
  const sub = r.show && wh && lh ? `Show: ${wh.name} beats ${lh.name}` : 'Everyone else packed';
  const kind = r.wellCutGame ? `Well Cut game ${r.wellCutGame} of 4 · ${r.cardsEach} card${r.cardsEach === 1 ? '' : 's'}` : `${r.cardsEach}-card game`;

  return (
    <div className={`sheet${open ? ' on' : ''}`} id="result" role="dialog" aria-label="Game result">
      <div className="grab" />
      <div className="res-top"><div className="lav" style={{ background: colorOf(r.winner) }}>{ini(r.winnerName)}</div>
        <div><b>{r.winner === view.you ? 'You win' : `${r.winnerName} wins`} {fmt(r.pot)}</b><span>{sub} · {kind}</span></div></div>
      {r.bonus && (
        <div className="bonus-line"><b>{r.bonus.kind === 'quad' ? 'Four of a Kind' : 'Three of a Kind'} bonus</b>
          <span>+{r.bonus.total}: {r.bonus.each} from each other player</span></div>
      )}
      <div className="res-stats">
        <div><small>Your coins</small><b className="num">{fmt(me?.coins ?? 0)}</b></div>
        <div><small>Your loan</small><b className="num">{fmt(me?.loan ?? 0)}</b></div>
        <div><small>Next dealer</small><b>{r.winner === view.you ? 'You' : w?.name}</b></div>
      </div>
      <div className={`verify${verify ? ' on' : ''}`}>
        {verify === 'ok'
          ? <><span className="ok">✓ Fingerprint matches</span>: the deck was fixed before the cut and not changed during the game.<br />Fingerprint: <code>{r.commit.slice(0, 16)}…</code><br />Deck order: <code>{r.deck}</code></>
          : <span style={{ color: '#FF8A8E' }}>✗ Mismatch: this deck does not match the fingerprint.</span>}
      </div>
      {view.scorecard?.kind === 'game' && (
        <div className="game-settle">
          <small>Game {r.game} settlement</small>
          {[...view.scorecard.rows].filter((x) => x.change !== 0).sort((a, b) => b.change - a.change).map((x) => (
            <span key={x.name}><b>{x.name}</b><i className={x.change > 0 ? 'up' : 'down'}>{sgn(x.change)}</i><em className="num">{fmt(x.balance)}</em></span>
          ))}
        </div>
      )}
      <div className="res-btns">
        <button className="btn line" onClick={onVerify}>Verify fairness</button>
        {view.callOff
          ? <button className="btn gold" disabled>Final settlement in {left}</button>
          : view.isAdmin
            ? <button className="btn gold" onClick={() => { client.send({ t: 'start_game' }); buzz(HAP.click); }}>{view.options.placecutDue ? 'Go to Placecut' : 'Next game'}</button>
            : <button className="btn gold" disabled>{view.options.placecutDue ? `Placecut in ${left}` : `Waiting for ${view.players.find((p) => p.isAdmin)?.name ?? 'the admin'}…`}</button>}
      </div>
    </div>
  );
}

/* ---------- bank loan ---------- */
function LoanSheet({ open, view, client, onClose }: { open: boolean; view: PlayerView; client: RoomClient; onClose: () => void }) {
  const o = view.options.loan;
  const me = view.players[view.you];
  const min = Math.max(1, o?.needed ?? 1);
  const max = o?.left ?? 0;
  const [amt, setAmt] = useState(min);
  const [lender, setLender] = useState<number | null>(null);
  const [ask, setAsk] = useState(20);
  useEffect(() => { if (open) setAmt(Math.min(max, Math.max(min, 10))); }, [open, min, max]);
  if (!me) return null;
  const others = view.players.map((p, i) => ({ ...p, i })).filter((p) => p.i !== view.you && p.coins > 0).sort((a, b) => b.coins - a.coins);
  const chosen = lender !== null ? view.players[lender] : null;
  const req = view.myRequest;
  return (
    <div className={`sheet${open ? ' on' : ''}`} role="dialog" aria-label="Loans">
      <div className="grab" />
      <h3>{view.options.borrow ? 'Borrow from a player' : 'Bank loan'} <span className="fine">{view.options.borrow ? 'Existing coins, never new ones' : `Up to ${view.rules.maxLoan} per player`}</span></h3>
      <div className="sheet-body">
        {view.options.borrow ? (
          req ? (
            <>
              <p className="note" style={{ marginTop: 0 }}>You asked <b style={{ color: 'var(--ivory)' }}>{view.players[req.to]?.name}</b> for <b style={{ color: 'var(--marigold)' }}>{req.amount} coins</b>. Waiting for their answer…</p>
              <div className="row2"><button className="btn line" onClick={onClose}>Close</button>
                <button className="btn line" style={{ color: '#FF9A9D' }} onClick={() => { client.send({ t: 'p2p_cancel' }); buzz(HAP.tick); }}>Cancel request</button></div>
            </>
          ) : (
            <>
              <p className="note" style={{ marginTop: 0 }}>You have used all 200 coins (your 100 and the full bank loan). Ask one player for any amount up to what they hold. If they agree the coins move at once, and you owe that amount to them until the tournament ends.</p>
              <div className="lender-list">
                {others.map((p) => (
                  <button key={p.i} className={`lender${lender === p.i ? ' on' : ''}`} onClick={() => { setLender(p.i); setAsk((a) => Math.min(a, p.coins)); play('tap'); }}>
                    <span className="lav" style={{ background: colorOf(p.i) }}>{ini(p.name)}</span><b>{p.name}</b><span className="num">{fmt(p.coins)}</span>
                  </button>
                ))}
                {!others.length && <p className="note">Nobody has coins to lend right now.</p>}
              </div>
              {chosen && (
                <>
                  <div className="loan-amt num"><b>{ask}</b><small>coins from {chosen.name}</small></div>
                  <input className="loan-range" type="range" min={1} max={Math.max(1, chosen.coins)} value={Math.min(ask, chosen.coins)} aria-label="Amount to ask for" onChange={(e) => { setAsk(Number(e.target.value)); play('tick'); buzz(HAP.peek); }} />
                  <div className="test-row" style={{ justifyContent: 'center', margin: '10px 0 14px' }}>
                    {[10, 20, 50, 100].filter((x) => x <= chosen.coins).map((x) => <button key={x} onClick={() => { setAsk(x); play('tick'); }}>{x}</button>)}
                  </div>
                </>
              )}
              <div className="row2">
                <button className="btn line" onClick={onClose}>Not now</button>
                <button className="btn gold" disabled={!chosen || ask < 1 || ask > (chosen?.coins ?? 0)} onClick={() => { client.send({ t: 'p2p_ask', to: lender!, amount: ask }); buzz(HAP.click); }}>{chosen ? `Ask ${chosen.name}` : 'Choose a player'}</button>
              </div>
            </>
          )
        ) : !o ? <p className="note">{me.loan >= view.rules.maxLoan ? `You have borrowed the full ${view.rules.maxLoan} coins from the bank. When you run out, you can borrow from a player.` : 'Loans are not available right now.'}</p> : (
          <>
            <p className="note" style={{ marginTop: 0 }}>{o.needed > 0 ? `You need ${o.needed} more coin${o.needed === 1 ? '' : 's'} for this turn.` : 'Borrow coins from the bank. The loan is recorded and stays owed until the tournament ends.'}
              {' '}You owe {fmt(me.loan)} now; {fmt(max)} more is available.</p>
            <div className="loan-amt num"><b>{amt}</b><small>coins</small></div>
            <input className="loan-range" type="range" min={min} max={max} value={amt} aria-label="Loan amount" onChange={(e) => { setAmt(Number(e.target.value)); play('tick'); buzz(HAP.peek); }} />
            <div className="test-row" style={{ justifyContent: 'center', margin: '10px 0 14px' }}>
              {[min, 10, 25, 50, max].filter((x, i, a) => x >= min && x <= max && a.indexOf(x) === i).map((x) => (
                <button key={x} onClick={() => { setAmt(x); play('tick'); }}>{x === max ? `All ${x}` : x}</button>
              ))}
            </div>
            <div className="row2">
              <button className="btn line" onClick={onClose}>Not now</button>
              <button className="btn gold" onClick={() => { client.loan(amt); onClose(); buzz(HAP.click); }}>Borrow {amt}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- a loan request for me to answer ---------- */
function LendSheet({ open, view, client, onClose }: { open: boolean; view: PlayerView; client: RoomClient; onClose: () => void }) {
  const r = view.incoming[0];
  const me = view.players[view.you];
  useEffect(() => { if (open && !r) onClose(); }, [open, r, onClose]);
  if (!r || !me) return <div className="sheet" />;
  const who = view.players[r.from];
  const enough = me.coins >= r.amount;
  return (
    <div className={`sheet${open ? ' on' : ''}`} role="dialog" aria-label="Loan request">
      <div className="grab" />
      <h3>Loan request</h3>
      <div className="confirm-body">
        <div className="res-top" style={{ margin: '0 0 12px' }}>
          <div className="lav" style={{ background: colorOf(r.from) }}>{ini(who?.name ?? '')}</div>
          <div><b>{who?.name} asks to borrow {r.amount} coins</b><span>You have {fmt(me.coins)}. {who?.name} will owe you {r.amount} until the tournament ends.</span></div>
        </div>
        {!enough && <p className="note" style={{ color: '#FF9A9D' }}>You don't have {r.amount} coins available right now.</p>}
        <div className="row2">
          <button className="btn line" onClick={() => { client.send({ t: 'p2p_answer', id: r.id, accept: false }); buzz(HAP.tick); onClose(); }}>Decline</button>
          <button className="btn gold" disabled={!enough} onClick={() => { client.send({ t: 'p2p_answer', id: r.id, accept: true }); play('clink', 4); buzz(HAP.click); onClose(); }}>Lend {r.amount}</button>
        </div>
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
  const s = view.players[seat];
  if (!s) return null;
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
