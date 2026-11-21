import { DurableObject } from 'cloudflare:workers';
import {
  type GameEvent, type Scorecard, type State, type Tx, DANKA_RULES, GameError, act, answerPlayerLoan, callOff, cancelPlayerLoan, commitmentInput, createRoom, cut, deal,
  isBotUid, newBot, nextBotTask, runBot,
  deckString, freshDeck, join, leave, removePlayer, needsDeck, onDeadline, prepareDeck, randomHex, seatOf, sessionReport, setConnected, setTableSize,
  requestPlayerLoan, setTimer, sha256Hex, shuffle, startGame, takeLoan, viewFor,
} from '@danka/engine';
import { ROOM_TTL_MS } from './codes';
import { CLOSE, THROWABLES, type ClientMsg, type ServerMsg } from './protocol';
import type { Env } from './index';

interface Saved {
  game: State;
  code: string;
  seq: number;
  /** Recent action ids, so a resent action is never applied twice (§17). */
  recent: string[];
  /** When the next computer player's move is due, and whose. */
  botAt?: number | null;
  botUid?: string | null;
}

interface Attachment {
  uid: string;
  name: string;
}

const RECENT_MAX = 400;
/** Extra time before an automatic pack (timer on), so a last-moment tap on a slow network still counts. */
const TURN_GRACE_MS = 1500;
/** Per-connection flood guard. */
const MAX_MSGS_PER_SEC = 20;

/**
 * §5 The dealer's STOP on the Well Cut timing bar. The phone says when (in server time) the dealer
 * tapped; the server only accepts a moment from the last fraction of a second before the tap
 * arrived, so a phone can't pick a better moment after the fact. Anything outside is clamped.
 */
const STOP_WINDOW_MS = 250;
export function stopTime(claimed: number, arrived: number): number {
  const at = Number.isFinite(claimed) ? claimed : arrived;
  return Math.min(arrived, Math.max(arrived - STOP_WINDOW_MS, at));
}

/**
 * One instance per room code: the single source of truth for that room's cards, turns,
 * rounds and coins. Phones only send intentions and draw what this object broadcasts.
 */
export class Room extends DurableObject<Env> {
  private s: Saved | null = null;
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats ("ping" → "pong") are answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // §17 The permanent ledger: every transaction, never deleted.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY, at INTEGER, round INTEGER, game INTEGER, uid TEXT, name TEXT,
      type TEXT, amount INTEGER, balance INTEGER, note TEXT)`);
    // Every settlement of the tournament, kept for the final report.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS settlements_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, game INTEGER, period INTEGER, json TEXT)');
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Saved>('room');
      this.s = saved && saved.game?.v === 4 ? saved : null;
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

  private async init(body: { code: string; uid: string; name: string; seats?: number; bots?: number }): Promise<Response> {
    if (this.s) return Response.json({ error: 'exists' }, { status: 409 });
    const now = Date.now();
    const rules = { ...DANKA_RULES, wellCutSequence: [...DANKA_RULES.wellCutSequence] };
    if (this.env.AUTH_MODE === 'dev') {
      if (Number(this.env.DEV_ROUND_SECONDS) > 0) { rules.roundMinutes = Number(this.env.DEV_ROUND_SECONDS) / 60; rules.forcedWellCutMinutes = rules.roundMinutes / 2; }
      if (Number(this.env.DEV_NEXT_GAME_SECONDS) > 0) rules.nextGameSeconds = Number(this.env.DEV_NEXT_GAME_SECONDS);
      if (Number(this.env.DEV_STARTING_COINS) > 0) rules.startingCoins = Number(this.env.DEV_STARTING_COINS);
      if (Number(this.env.DEV_MAX_LOAN) >= 0 && this.env.DEV_MAX_LOAN !== undefined) rules.maxLoan = Number(this.env.DEV_MAX_LOAN);
    }
    const game = createRoom({
      rules,
      admin: { uid: body.uid, name: body.name },
      now,
      tableSize: body.seats,
    });
    this.s = { game, code: body.code, seq: 1, recent: [] };
    // "Play with computer": seat the computer players straight away (the table grows to fit them).
    const bots = Math.max(0, Math.min(game.rules.maxPlayers - 1, Number(body.bots) || 0));
    if (bots) game.tableSize = Math.max(game.tableSize, bots + 1);
    for (let k = 0; k < bots; k++) { const b = newBot(game); join(game, b.uid, b.name, now); }
    this.flushLedger();
    await this.persist();
    await this.scheduleAlarm();
    return Response.json({ code: body.code });
  }

  private info() {
    if (!this.s) return { exists: false };
    const g = this.s.game;
    return {
      exists: true,
      phase: g.phase,
      round: g.round,
      game: g.game,
      seats: g.players.length,
      tableSize: g.tableSize,
      full: g.players.length >= g.tableSize,
      joinable: g.phase === 'lobby' || g.phase === 'placecut',
      closed: g.phase === 'ended',
      expired: this.expired(),
      players: g.players.map((p) => p.name),
    };
  }

  /** Rooms that never start a round expire after 24 hours. Played rooms keep their history. */
  private expired(): boolean {
    return !!this.s && this.s.game.round === 0 && this.s.game.phase === 'lobby' && Date.now() - this.s.game.createdAt > ROOM_TTL_MS;
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
          if (from < 0 || !THROWABLES.includes(msg.kind) || !(msg.to >= 0 && msg.to < g.players.length)) return;
          return this.broadcastRaw({ t: 'react', from, to: msg.to, kind: msg.kind });
        }
        case 'chat': {
          const from = seatOf(g, me.uid);
          const text = String(msg.text ?? '').trim().slice(0, 120);
          if (from < 0 || !text) return;
          return this.broadcastRaw({ t: 'chat', from, text, at: now });
        }
        case 'act':
        case 'loan': {
          const key = `${me.uid}:${msg.id}`;
          if (msg.id && this.s.recent.includes(key)) return this.send(ws, { t: 'ack', id: msg.id });
          const events = msg.t === 'act' ? act(g, me.uid, msg.action, now) : takeLoan(g, me.uid, Number(msg.amount), now);
          if (msg.id) {
            this.s.recent.push(key);
            if (this.s.recent.length > RECENT_MAX) this.s.recent.splice(0, this.s.recent.length - RECENT_MAX);
          }
          await this.commit(events);
          if (msg.id) this.send(ws, { t: 'ack', id: msg.id });
          return;
        }
        case 'start_game':
          return this.commit(startGame(g, me.uid, now));
        case 'p2p_ask':
          return this.commit(requestPlayerLoan(g, me.uid, Number(msg.to), Number(msg.amount), now));
        case 'p2p_answer':
          return this.commit(answerPlayerLoan(g, me.uid, Number(msg.id), !!msg.accept, now));
        case 'p2p_cancel':
          return this.commit(cancelPlayerLoan(g, me.uid));
        case 'add_bot': {
          if (me.uid !== g.adminUid) return this.send(ws, { t: 'error', code: 'not_admin', message: 'Only the admin can add computer players.' });
          if (g.players.length >= g.tableSize) setTableSize(g, me.uid, g.players.length + 1);
          const b = newBot(g);
          return this.commit(join(g, b.uid, b.name, now).events);
        }
        case 'remove_bot': {
          // the admin removes a computer player, or (at Placecut / before the first period) a person
          if (me.uid !== g.adminUid) return this.send(ws, { t: 'error', code: 'not_admin', message: 'Only the admin can remove players.' });
          const p = g.players[Number(msg.seat)];
          if (!p) return this.send(ws, { t: 'error', code: 'no_player', message: 'That seat is empty.' });
          if (isBotUid(p.uid)) return this.commit(leave(g, p.uid, now));
          const events = removePlayer(g, me.uid, Number(msg.seat), now);
          await this.commit(events);
          for (const s of this.ctx.getWebSockets(p.uid)) { try { s.close(CLOSE.LEFT, 'removed'); } catch { /* already closed */ } }
          return;
        }
        case 'call_off':
          return this.commit(callOff(g, me.uid, now));
        case 'timer':
          return this.commit(setTimer(g, me.uid, !!msg.on, now));
        case 'size':
          return this.commit(setTableSize(g, me.uid, Number(msg.size)));
        case 'cut':
          return this.commit(cut(g, me.uid, stopTime(Number(msg.at), now), now));
        case 'deal':
          return this.commit(deal(g, me.uid, now));
        case 'leave': {
          const events = leave(g, me.uid, now);
          await this.commit(events);
          ws.close(CLOSE.LEFT, 'left');
          return;
        }
        case 'report': {
          if (me.uid !== g.adminUid) return this.send(ws, { t: 'error', code: 'not_admin', message: 'Only the admin can export the settlement report.' });
          const ledger = this.ctx.storage.sql.exec('SELECT * FROM ledger ORDER BY id').toArray() as unknown as Tx[];
          const scorecards = this.ctx.storage.sql.exec('SELECT json FROM settlements_v2 ORDER BY id').toArray().map((r) => JSON.parse(String(r.json)) as Scorecard);
          return this.send(ws, { t: 'report', report: { ...sessionReport(g), scorecards, ledger, code: this.s.code } });
        }
        default:
          return this.send(ws, { t: 'error', code: 'bad_message', message: 'Unknown message.' });
      }
    } catch (e) {
      if (e instanceof GameError) {
        const ref = msg.t === 'act' || msg.t === 'loan' ? msg.id : undefined;
        return this.send(ws, { t: 'error', code: e.code, message: e.message, ref });
      }
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
    this.buckets.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /* ---------------- timers ---------------- */

  async alarm(): Promise<void> {
    if (!this.s) return;
    const now = Date.now();
    if (this.expired()) {
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    let events: GameEvent[] = [];
    // a computer player's move
    if (this.s.botAt && this.s.botUid && now >= this.s.botAt - 20) {
      events = this.botMove(this.s.botUid, now);
    }
    events = events.concat(onDeadline(this.s.game, now));
    await this.commit(events);
  }

  /** Play one computer move. A move the rules refuse falls back to packing, so a bot can never stall a table. */
  private botMove(uid: string, now: number): GameEvent[] {
    const g = this.s!.game;
    try {
      return runBot(g, uid, now);
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      console.warn('bot move refused', uid, e.code);
      try {
        return g.phase === 'betting' && g.players[g.turn]?.uid === uid ? act(g, uid, { type: 'pack' }, now) : [];
      } catch { return []; }
    }
  }

  /* ---------------- internals ---------------- */

  /** After any change: shuffle if needed, save the ledger and state, set the next alarm, tell everyone. */
  private async commit(events: GameEvent[]): Promise<void> {
    const s = this.s!;
    while (needsDeck(s.game)) events = events.concat(await this.shuffleIn());
    const task = nextBotTask(s.game, Date.now());
    s.botAt = task?.at ?? null;
    s.botUid = task?.uid ?? null;
    s.seq++;
    this.flushLedger();
    await this.persist();
    await this.scheduleAlarm();
    this.broadcastState(events);
  }

  /** §4 A fresh 52-card deck, shuffled here with unbiased crypto randomness. The fingerprint is published first. */
  private async shuffleIn(): Promise<GameEvent[]> {
    const deck = shuffle(freshDeck());
    const salt = randomHex(16);
    const commit = await sha256Hex(commitmentInput(deckString(deck), salt));
    return prepareDeck(this.s!.game, deck, salt, commit, Date.now());
  }

  private flushLedger(): void {
    const g = this.s!.game;
    for (const t of g.outbox) {
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO ledger (id, at, round, game, uid, name, type, amount, balance, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        t.id, t.at, t.round, t.game, t.uid, t.name, t.type, t.amount, t.balance, t.note ?? null,
      );
    }
    g.outbox = [];
    for (const c of g.cardOutbox ?? []) {
      this.ctx.storage.sql.exec('INSERT INTO settlements_v2 (kind, game, period, json) VALUES (?, ?, ?, ?)', c.kind, c.round, c.period, JSON.stringify(c));
    }
    g.cardOutbox = [];
  }

  private async scheduleAlarm(): Promise<void> {
    const g = this.s!.game;
    const d = g.deadline;
    const due = d ? d.at + (d.kind === 'turn' ? TURN_GRACE_MS : 0) : null;
    const bot = this.s!.botAt ?? null;
    const next = due !== null && bot !== null ? Math.min(due, bot) : due ?? bot;
    const at = next ?? (g.phase === 'lobby' && g.round === 0 ? g.createdAt + ROOM_TTL_MS : null);
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
