import type { Action } from '@danka/engine';
import type { ClientMsg, ServerMsg, SessionReport } from '../../../server/src/protocol';

export type { ClientMsg, ServerMsg, SessionReport };
export type Status = 'connecting' | 'open' | 'reconnecting' | 'rejected' | 'replaced' | 'left' | 'closed';

/** The server lives on the same origin in the browser; the Android app sets VITE_SERVER_URL. */
export const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? location.origin;

/** Create a room; `bots` computer players are seated straight away ("Play with computer"). */
export async function createRoom(token: string, seats: number, bots = 0): Promise<string> {
  const res = await fetch(`${SERVER}/api/rooms`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ seats, bots }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? 'Could not create a room.');
  return body.code;
}

export interface RoomInfo { exists: boolean; joinable?: boolean; round?: number; full?: boolean; seats?: number; tableSize?: number; closed?: boolean; expired?: boolean; phase?: string; players?: string[] }

export async function roomInfo(code: string): Promise<{ ok: true; info: RoomInfo } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${SERVER}/api/rooms/${encodeURIComponent(code)}`);
    const body = await res.json();
    if (!res.ok) return { ok: false, message: body.message ?? 'That code did not work.' };
    return { ok: true, info: body };
  } catch {
    return { ok: false, message: 'No connection. Check your internet and try again.' };
  }
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

/** Connection quality for the signal dot. */
export type Quality = 'good' | 'fair' | 'poor' | 'offline';

const HEARTBEAT_MS = 10_000; // keep-alive "ping"; answered by the server without waking it
const DEAD_AFTER_MS = 25_000; // no message for this long = silently dead connection (common on 4G/Wi-Fi switches)
const TIME_SYNC_MS = 60_000; // server-clock sync for turn timers

/**
 * One live connection to a room. Detects silently dead connections with a heartbeat,
 * reconnects with jittered back-off, ignores out-of-order states, and resends
 * unacknowledged bets after a reconnect (the server ignores duplicates by id).
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  private pending = new Map<string, ClientMsg>();
  private beatTimer = 0;
  private syncTimer = 0;
  private reconnectTimer = 0;
  private lastHeard = 0;
  private beatSentAt = 0;
  private lastSeq = 0;
  /** server time − local time, from time-sync pings */
  offset = 0;
  /** last measured round-trip time in ms */
  rtt = 0;

  constructor(
    private code: string,
    private token: string,
    private onMsg: (m: ServerMsg) => void,
    private onStatus: (s: Status, detail?: { code: string; message: string }) => void,
    private onQuality: (q: Quality, rtt: number) => void = () => {},
  ) {
    this.open();
  }

  serverNow = (): number => Date.now() + this.offset;

  private open() {
    clearTimeout(this.reconnectTimer);
    const url = `${SERVER.replace(/^http/, 'ws')}/api/rooms/${this.code}/ws?token=${encodeURIComponent(this.token)}`;
    this.onStatus(this.retry ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { return this.scheduleReconnect(); }
    this.ws = ws;
    let rejection: { code: string; message: string } | undefined;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.retry = 0;
      this.lastHeard = Date.now();
      this.onStatus('open');
      for (const m of this.pending.values()) ws.send(JSON.stringify(m));
      this.timeSync();
      clearInterval(this.beatTimer);
      clearInterval(this.syncTimer);
      this.beatTimer = window.setInterval(() => this.beat(), HEARTBEAT_MS);
      this.syncTimer = window.setInterval(() => this.timeSync(), TIME_SYNC_MS);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.lastHeard = Date.now();
      if (ev.data === 'pong') { this.measure(Date.now() - this.beatSentAt); return; }
      let m: ServerMsg;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'pong') {
        const now = Date.now();
        this.offset = m.s - (m.c + now) / 2;
        this.measure(now - m.c);
        return;
      }
      if (m.t === 'ack') { this.pending.delete(m.id); return; }
      if (m.t === 'state') {
        if (m.seq <= this.lastSeq) return; // out of order or duplicate
        this.lastSeq = m.seq;
      }
      if (m.t === 'error') {
        if (m.ref) this.pending.delete(m.ref);
        rejection = { code: m.code, message: m.message };
      }
      this.onMsg(m);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      clearInterval(this.beatTimer);
      clearInterval(this.syncTimer);
      if (this.stopped) return;
      if (ev.code === 4000) return this.onStatus('rejected', rejection);
      if (ev.code === 4001) return this.onStatus('replaced');
      if (ev.code === 4002) return this.onStatus('left');
      if (ev.code === 4003) return this.onStatus('closed');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.retry++;
    this.onStatus('reconnecting');
    this.onQuality('offline', 0);
    // Exponential back-off with jitter, so 7 phones don't all hit the server at the same instant.
    const base = Math.min(8000, 300 * 2 ** Math.min(this.retry - 1, 5));
    const delay = this.retry === 1 ? 150 + Math.random() * 300 : base * (0.5 + Math.random() * 0.5);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private measure(rtt: number) {
    this.rtt = rtt;
    this.onQuality(rtt < 250 ? 'good' : rtt < 700 ? 'fair' : 'poor', rtt);
  }

  private beat() {
    if (Date.now() - this.lastHeard > DEAD_AFTER_MS) return this.forceReconnect();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.beatSentAt = Date.now();
      this.ws.send('ping');
    }
  }

  private timeSync() {
    this.raw({ t: 'ping', c: Date.now() });
  }

  /** Drop a connection that looks alive but isn't, and open a fresh one now. */
  private forceReconnect() {
    const old = this.ws;
    this.ws = null;
    try { old?.close(); } catch { /* ignore */ }
    this.retry = 0;
    this.open();
  }

  private raw(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  send(m: ClientMsg) {
    this.raw(m);
  }

  act(action: Action) {
    const msg: ClientMsg = { t: 'act', id: uuid(), action };
    this.pending.set(msg.id, msg);
    this.raw(msg);
  }

  /** Borrow from the bank. Resent after a dropout like a bet; the server applies it once. */
  loan(amount: number) {
    const msg: ClientMsg = { t: 'loan', id: uuid(), amount };
    this.pending.set(msg.id, msg);
    this.raw(msg);
  }

  /** The app came back to the foreground or the network came back: make sure we are really connected. */
  wake() {
    if (this.stopped) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) { this.retry = 0; return this.open(); }
    if (Date.now() - this.lastHeard > HEARTBEAT_MS * 1.5) return this.forceReconnect();
    this.timeSync();
  }

  offline() {
    this.onQuality('offline', 0);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.beatTimer);
    clearInterval(this.syncTimer);
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(1000); } catch { /* ignore */ }
  }
}
