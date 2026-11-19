import { DurableObject } from 'cloudflare:workers';
import {
  type GameEvent, type GameState, type SessionMode, GameError, SESSION_MODES, STAND_IN_RULES,
  close, commitmentInput, createGame, deal, deckString, freshDeck, join, leave, needsDeck, nextHand,
  onDeadline, pickMode, prepareDeal, randomHex, seatOf, setConnected, setReady, setSessionMode, sha256Hex,
  shuffle, start, act, viewFor,
} from '@danka/engine';
import { ROOM_TTL_MS } from './codes';
import { CLOSE, THROWABLES, type ClientMsg, type ServerMsg } from './protocol';
import type { Env } from './index';

interface Saved {
  game: GameState;
  code: string;
  seq: number;
  /** Recent action ids, so a resent bet is never applied twice. */
  recent: string[];
  purgeAt: number | null;
}

interface Attachment {
  uid: string;
  name: string;
}

const RECENT_MAX = 300;
const PURGE_AFTER_CLOSE_MS = 60 * 60 * 1000;
/** Extra time before an auto-pack, so a tap sent in the last moment on a slow network still counts. */
const TURN_GRACE_MS = 1500;
/** Per-connection flood guard: at most this many messages per second. */
const MAX_MSGS_PER_SEC = 20;

/**
 * One instance per room code. The single source of truth for that room's
 * cards, turns, timers and coins. Phones only send intentions and draw what
 * this object broadcasts.
 */
export class Room extends DurableObject<Env> {
  private s: Saved | null = null;
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats ("ping" → "pong") are answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<Saved>('room')) ?? null;
    });
  }

  /* ---------------- HTTP from the Worker ---------------- */

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/init' && req.method === 'POST') return this.init(await req.json());
    if (url.pathname === '/info') return Response.json(this.info());
    if (url.pathname === '/ws') return this.openSocket(req);
    return new Response('Not found', { status: 404 });
  }

  private async init(body: { code: string; mode: SessionMode; uid: string; name: string }): Promise<Response> {
    if (this.s) return Response.json({ error: 'exists' }, { status: 409 });
    const mode = SESSION_MODES.includes(body.mode) ? body.mode : 'classic';
    const now = Date.now();
    const game = createGame({ rules: { ...STAND_IN_RULES }, sessionMode: mode, admin: { uid: body.uid, name: body.name }, now });
    this.s = { game, code: body.code, seq: 1, recent: [], purgeAt: null };
    await this.persist();
    return Response.json({ code: body.code });
  }

  private info() {
    if (!this.s) return { exists: false };
    const g = this.s.game;
    return {
      exists: true,
      phase: g.phase,
      seats: g.seats.length,
      full: g.seats.length >= 7,
      closed: g.phase === 'closed',
      expired: this.expired(),
      sessionMode: g.sessionMode,
      players: g.seats.map((s) => s.name),
    };
  }

  private expired(): boolean {
    return !!this.s && this.s.game.phase === 'waiting' && Date.now() - this.s.game.createdAt > ROOM_TTL_MS;
  }

  private async openSocket(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const uid = req.headers.get('x-uid')!;
    const name = req.headers.get('x-name') ?? 'Player';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const reject = (code: string, message: string) => {
      server.accept();
      server.send(JSON.stringify({ t: 'error', code, message } satisfies ServerMsg));
      server.close(CLOSE.REJECTED, code);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!this.s) return reject('room_not_found', 'No room with that code.');
    if (this.expired()) return reject('room_expired', 'This room code has expired. Ask for a new one.');

    let events: GameEvent[];
    try {
      events = join(this.s.game, uid, name, Date.now()).events;
    } catch (e) {
      if (e instanceof GameError) return reject(e.code, e.message);
      throw e;
    }

    // One live connection per player: a new phone or tab replaces the old one.
    for (const ws of this.ctx.getWebSockets(uid)) {
      try { ws.close(CLOSE.REPLACED, 'replaced'); } catch { /* already closed */ }
    }
    this.ctx.acceptWebSocket(server, [uid]);
    server.serializeAttachment({ uid, name } satisfies Attachment);
    await this.commit(events);
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------- WebSocket messages ---------------- */

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.s) return;
    const me = ws.deserializeAttachment() as Attachment;
    if (!this.allow(ws)) return this.send(ws, { t: 'error', code: 'slow_down', message: 'Too many taps. Slow down a little.' });
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { t: 'error', code: 'bad_message', message: 'Could not read that message.' });
    }
    const g = this.s.game;
    const now = Date.now();

    try {
      switch (msg.t) {
        case 'ping':
          return this.send(ws, { t: 'pong', c: msg.c, s: now });
        case 'react': {
          const from = seatOf(g, me.uid);
          if (from < 0 || !THROWABLES.includes(msg.kind) || !(msg.to >= 0 && msg.to < g.seats.length)) return;
          return this.broadcastRaw({ t: 'react', from, to: msg.to, kind: msg.kind });
        }
        case 'chat': {
          const from = seatOf(g, me.uid);
          const text = String(msg.text ?? '').trim().slice(0, 120);
          if (from < 0 || !text) return;
          return this.broadcastRaw({ t: 'chat', from, text, at: now });
        }
        case 'act': {
          const key = `${me.uid}:${msg.id}`;
          if (msg.id && this.s.recent.includes(key)) return this.send(ws, { t: 'ack', id: msg.id });
          const events = act(g, me.uid, msg.action, now);
          if (msg.id) {
            this.s.recent.push(key);
            if (this.s.recent.length > RECENT_MAX) this.s.recent.splice(0, this.s.recent.length - RECENT_MAX);
          }
          await this.commit(events);
          if (msg.id) this.send(ws, { t: 'ack', id: msg.id });
          return;
        }
        case 'ready':
          return this.commit(setReady(g, me.uid, !!msg.ready));
        case 'mode':
          return this.commit(setSessionMode(g, me.uid, msg.mode));
        case 'start':
          return this.commit(start(g, me.uid, now));
        case 'pick':
          return this.commit(pickMode(g, me.uid, msg.mode, now));
        case 'deal':
          return this.commit(deal(g, me.uid, now));
        case 'next':
          return this.commit(nextHand(g, now));
        case 'leave': {
          const events = leave(g, me.uid, now);
          await this.commit(events);
          ws.close(CLOSE.LEFT, 'left');
          return;
        }
        case 'close': {
          const events = close(g, me.uid, now);
          this.s.purgeAt = now + PURGE_AFTER_CLOSE_MS;
          await this.commit(events);
          for (const s of this.ctx.getWebSockets()) try { s.close(CLOSE.ROOM_CLOSED, 'closed'); } catch { /* ignore */ }
          return;
        }
        default:
          return this.send(ws, { t: 'error', code: 'bad_message', message: 'Unknown message.' });
      }
    } catch (e) {
      if (e instanceof GameError) return this.send(ws, { t: 'error', code: e.code, message: e.message, ref: msg.t === 'act' ? msg.id : undefined });
      console.error('room error', e);
      return this.send(ws, { t: 'error', code: 'server_error', message: 'Something went wrong. Try again.' });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.dropped(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropped(ws);
  }

  private async dropped(ws: WebSocket): Promise<void> {
    if (!this.s) return;
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me) return;
    const stillOpen = this.ctx.getWebSockets(me.uid).some((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (stillOpen) return;
    setConnected(this.s.game, me.uid, false);
    await this.commit([]);
  }

  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.buckets.get(ws) ?? { tokens: MAX_MSGS_PER_SEC, at: now };
    b.tokens = Math.min(MAX_MSGS_PER_SEC, b.tokens + ((now - b.at) / 1000) * MAX_MSGS_PER_SEC);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(ws, b); return false; }
    b.tokens -= 1;
    this.buckets.set(ws, b);
    return true;
  }

  /* ---------------- timers ---------------- */

  async alarm(): Promise<void> {
    if (!this.s) return;
    const now = Date.now();
    if (this.s.purgeAt && now >= this.s.purgeAt) {
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    if (this.expired()) {
      this.s.game.phase = 'closed';
      this.s.purgeAt = now;
      await this.persist();
      await this.ctx.storage.setAlarm(now + 1000);
      return;
    }
    await this.commit(onDeadline(this.s.game, now));
  }

  /* ---------------- internals ---------------- */

  /** After any change: shuffle if the engine needs a deck, save, set the next alarm, and tell everyone. */
  private async commit(events: GameEvent[]): Promise<void> {
    const s = this.s!;
    if (needsDeck(s.game)) events = events.concat(await this.shuffleIn());
    s.seq++;
    await this.persist();
    await this.scheduleAlarm();
    this.broadcastState(events);
  }

  /** Fresh 52-card deck, cryptographically shuffled here on the server. The fingerprint is published before the deal. */
  private async shuffleIn(): Promise<GameEvent[]> {
    const deck = shuffle(freshDeck());
    const salt = randomHex(16);
    const commit = await sha256Hex(commitmentInput(deckString(deck), salt));
    return prepareDeal(this.s!.game, deck, salt, commit, Date.now());
  }

  private async scheduleAlarm(): Promise<void> {
    const s = this.s!;
    const d = s.game.deadline;
    const due = d ? d.at + (d.kind === 'turn' ? TURN_GRACE_MS : 0) : null;
    const at = s.purgeAt ?? due ?? (s.game.phase === 'waiting' ? s.game.createdAt + ROOM_TTL_MS : null);
    if (at) await this.ctx.storage.setAlarm(at);
    else await this.ctx.storage.deleteAlarm();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('room', this.s);
  }

  private broadcastState(events: GameEvent[]): void {
    const s = this.s!;
    for (const ws of this.ctx.getWebSockets()) {
      const me = ws.deserializeAttachment() as Attachment | null;
      if (!me) continue;
      this.send(ws, { t: 'state', seq: s.seq, code: s.code, view: viewFor(s.game, me.uid), events });
    }
  }

  private broadcastRaw(msg: ServerMsg): void {
    for (const ws of this.ctx.getWebSockets()) this.send(ws, msg);
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
  }
}
