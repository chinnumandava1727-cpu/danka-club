// The card table is laid out upright at a fixed width of 430 design pixels (height 740–960 to match the
// phone) and scaled to fit the screen, so seats, piles and the rail line up the same on every phone.
import { useLayoutEffect, useState } from 'react';

export const DESIGN_W = 430;
export const frame = { on: false, k: 1, tx: 0, ty: 0, H: 932 };

/** Screen (client) coordinates → coordinates inside #app. */
export function toLocal(x: number, y: number) {
  if (!frame.on) {
    const a = document.getElementById('app')!.getBoundingClientRect();
    return { x: x - a.left, y: y - a.top };
  }
  return { x: (x - frame.tx) / frame.k, y: (y - frame.ty) / frame.k };
}

function apply() {
  const app = document.getElementById('app');
  if (!app) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const H = Math.round(Math.min(960, Math.max(740, (DESIGN_W * vh) / vw)));
  const k = Math.min(vw / DESIGN_W, vh / H);
  const tx = (vw - DESIGN_W * k) / 2, ty = (vh - H * k) / 2;
  Object.assign(frame, { on: true, k, tx, ty, H });
  app.classList.add('casino');
  app.style.width = `${DESIGN_W}px`;
  app.style.height = `${H}px`;
  app.style.transform = `translate(${tx}px,${ty}px) scale(${k})`;
  return H;
}

function clear() {
  const app = document.getElementById('app');
  frame.on = false;
  if (!app) return;
  app.classList.remove('casino');
  app.style.width = app.style.height = app.style.transform = '';
}

/** Switch #app to the upright table frame while mounted; returns the design height. */
export function useTableFrame(): number {
  const [H, setH] = useState(frame.H);
  useLayoutEffect(() => {
    const go = () => { const h = apply(); if (h) setH(h); };
    go();
    const late = () => setTimeout(go, 250);
    window.addEventListener('resize', go);
    window.addEventListener('orientationchange', late);
    return () => { window.removeEventListener('resize', go); window.removeEventListener('orientationchange', late); clear(); };
  }, []);
  return H;
}
