// Imperative animation layer: chips, flying cards, throwables and bursts drawn above the table.
import { settings } from './settings';

const app = () => document.getElementById('app')!;
const layer = () => document.getElementById('fx')!;

export interface Pt { x: number; y: number }

export function centerOf(el: Element | null): Pt | null {
  if (!el) return null;
  const a = app().getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: r.left - a.left + r.width / 2, y: r.top - a.top + r.height / 2 };
}

export const seatAvatar = (seat: number) => document.querySelector(`[data-seat="${seat}"] .av`);
export const seatMinis = (seat: number) => document.querySelector(`[data-seat="${seat}"] .minis`) ?? seatAvatar(seat);
export const potEl = () => document.querySelector('.pot');
export const deckEl = () => document.getElementById('deck');

interface FlyOpts { delay?: number; arc?: number; spin?: number; s0?: number; s1?: number; keep?: boolean }

export function fly(cls: string, html: string, from: Pt | null, to: Pt | null, dur: number, o: FlyOpts = {}): Promise<void> {
  if (!from || !to) return Promise.resolve();
  const el = document.createElement('div');
  el.className = `fly ${cls}`;
  if (html) el.innerHTML = html;
  layer().appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  const dx = from.x - w / 2, dy = from.y - h / 2, tx = to.x - w / 2, ty = to.y - h / 2;
  const lift = settings.reduce ? 0 : o.arc ?? 40;
  const mx = (dx + tx) / 2, my = Math.min(dy, ty) - lift, rot = o.spin ?? 0;
  const kf = settings.reduce
    ? [{ transform: `translate(${tx}px,${ty}px)`, opacity: 0 }, { transform: `translate(${tx}px,${ty}px)`, opacity: 1 }]
    : [
        { transform: `translate(${dx}px,${dy}px) rotate(0deg) scale(${o.s0 ?? 1})` },
        { transform: `translate(${mx}px,${my}px) rotate(${rot / 2}deg) scale(1.08)`, offset: 0.5 },
        { transform: `translate(${tx}px,${ty}px) rotate(${rot}deg) scale(${o.s1 ?? 1})` },
      ];
  const an = el.animate(kf, { duration: settings.reduce ? 120 : dur, delay: o.delay ?? 0, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'both' });
  return an.finished.then(() => { if (!o.keep) el.remove(); }).catch(() => el.remove());
}

export function chip(from: Pt | null, to: Pt | null, delay = 0) {
  return fly('chip', '', from, to, 420, { delay, arc: 30 });
}

export function burst(at: Pt | null, colors: string[], n = 14) {
  if (!at || settings.reduce) return;
  for (let k = 0; k < n; k++) {
    const b = document.createElement('div');
    b.className = 'burst';
    b.style.background = colors[k % colors.length];
    b.style.left = `${at.x - 4}px`;
    b.style.top = `${at.y - 4}px`;
    layer().appendChild(b);
    const ang = Math.random() * Math.PI * 2, dist = 24 + Math.random() * 34;
    b.animate(
      [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(ang) * dist}px,${Math.sin(ang) * dist}px) scale(.3)`, opacity: 0 }],
      { duration: 600 + Math.random() * 300, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' },
    ).finished.then(() => b.remove());
  }
}

export function pulse(el: Element | null) {
  el?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18) rotate(-6deg)' }, { transform: 'scale(1)' }], { duration: 380 });
}

export function shuffleDeck() {
  if (settings.reduce) return;
  const ks = document.querySelectorAll('#deck .dk');
  if (ks.length < 3) return;
  ks[0].animate([{ transform: 'translate(-3px,3px)' }, { transform: 'translate(-26px,0) rotate(-12deg)' }, { transform: 'translate(-3px,3px)' }, { transform: 'translate(-22px,0) rotate(-8deg)' }, { transform: 'translate(-3px,3px)' }], { duration: 1300, easing: 'ease-in-out' });
  ks[2].animate([{ transform: 'none' }, { transform: 'translate(26px,0) rotate(12deg)' }, { transform: 'none' }, { transform: 'translate(22px,0) rotate(8deg)' }, { transform: 'none' }], { duration: 1300, easing: 'ease-in-out' });
}
