import type { Action, SessionMode } from '@danka/engine';
import type { ClientMsg, ServerMsg } from '../../../server/src/protocol';

export type { ClientMsg, ServerMsg };
export type Status = 'connecting' | 'open' | 'reconnecting' | 'rejected' | 'replaced' | 'left' | 'closed';

/** The server lives on the same origin in the browser; the Android app sets VITE_SERVER_URL. */
export const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? location.origin;

export async function createRoom(token: string, mode: SessionMode): Promise<string> {
  const res = await fetch(`${SERVER}/api/rooms`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? 'Could not create a room.');
  return body.code;
}

export interface RoomInfo { exists: boolean; full?: boolean; closed?: boolean; expired?: boolean; phase?: string; players?: string[] }

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

/**
 * One live connection to a room. Reconnects by itself with back-off and resends
 * unacknowledged bets (the server ignores duplicates by id).
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  private pending = new Map<string, ClientMsg>();
  private pingTimer = 0;
  private reconnectTimer = 0;
  /** server time − local time, from ping/pong */
  offset = 0;

  constructor(
    private code: string,
    private token: string,
    private onMsg: (m: ServerMsg) => void,
    private onStatus: (s: Status, detail?: { code: string; message: string }) => void,
  ) {
    this.open();
  }

  serverNow = (): number => Date.now() + this.offset;

  private open() {
    const url = `${SERVER.replace(/^http/, 'ws')}/api/rooms/${this.code}/ws?token=${encodeURIComponent(this.token)}`;
    this.onStatus(this.retry ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    let rejection: { code: string; message: string } | undefined;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      for (const m of this.pending.values()) ws.send(JSON.stringify(m));
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 15000);
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'pong') {
        const now = Date.now();
        this.offset = m.s - (m.c + now) / 2;
        return;
      }
      if (m.t === 'ack') { this.pending.delete(m.id); return; }
      if (m.t === 'error') {
        if (m.ref) this.pending.delete(m.ref);
        rejection = { code: m.code, message: m.message };
      }
      this.onMsg(m);
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      if (ev.code === 4000) return this.onStatus('rejected', rejection);
      if (ev.code === 4001) return this.onStatus('replaced');
      if (ev.code === 4002) return this.onStatus('left');
      if (ev.code === 4003) return this.onStatus('closed');
      this.retry++;
      this.onStatus('reconnecting');
      const delay = Math.min(8000, 400 * 2 ** Math.min(this.retry, 5));
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    };
  }

  private ping() {
    this.raw({ t: 'ping', c: Date.now() });
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

  /** Reconnect immediately (for the app coming back to the foreground). */
  wake() {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      clearTimeout(this.reconnectTimer);
      this.open();
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(1000); } catch { /* ignore */ }
  }
}
