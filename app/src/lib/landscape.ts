// The card table is laid out sideways at a fixed height of 430 design pixels and scaled to the screen.
// Held upright, the whole frame is turned 90° so the table still fills the phone (turn the phone to play).
import { useLayoutEffect, useState } from 'react';

export const DESIGN_H = 430;
export const frame = { on: false, rot: false, k: 1, tx: 0, ty: 0, W: 932 };

/** Screen (client) coordinates → coordinates inside #app. */
export function toLocal(x: number, y: number) {
  if (!frame.on) {
    const a = document.getElementById('app')!.getBoundingClientRect();
    return { x: x - a.left, y: y - a.top };
  }
  return frame.rot ? { x: (y - frame.ty) / frame.k, y: (frame.tx - x) / frame.k } : { x: (x - frame.tx) / frame.k, y: (y - frame.ty) / frame.k };
}

function apply() {
  const app = document.getElementById('app');
  if (!app) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rot = vh > vw * 1.05;
  const sw = rot ? vh : vw, sh = rot ? vw : vh;
  const W = Math.round(Math.min(980, Math.max(840, (DESIGN_H * sw) / sh)));
  const k = Math.min(sw / W, sh / DESIGN_H);
  let tx: number, ty: number;
  if (rot) { tx = (vw + DESIGN_H * k) / 2; ty = (vh - W * k) / 2; } else { tx = (vw - W * k) / 2; ty = (vh - DESIGN_H * k) / 2; }
  Object.assign(frame, { on: true, rot, k, tx, ty, W });
  app.classList.add('land');
  app.style.width = `${W}px`;
  app.style.height = `${DESIGN_H}px`;
  app.style.transform = `translate(${tx}px,${ty}px)${rot ? ' rotate(90deg)' : ''} scale(${k})`;
  return W;
}

function clear() {
  const app = document.getElementById('app');
  frame.on = false;
  if (!app) return;
  app.classList.remove('land');
  app.style.width = app.style.height = app.style.transform = '';
}

/** Switch #app to the sideways table frame while mounted; returns the design width. */
export function useLandscape(): number {
  const [W, setW] = useState(frame.W);
  useLayoutEffect(() => {
    const go = () => { const w = apply(); if (w) setW(w); };
    go();
    const late = () => setTimeout(go, 250);
    window.addEventListener('resize', go);
    window.addEventListener('orientationchange', late);
    return () => { window.removeEventListener('resize', go); window.removeEventListener('orientationchange', late); clear(); };
  }, []);
  return W;
}
