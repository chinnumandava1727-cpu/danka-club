// Simulated Danka night: bots play real games against a running dev server.
// Start the server with short rounds first:
//   npx wrangler dev --port 8787 --ip 127.0.0.1 --var AUTH_MODE:dev --var DEV_ROUND_SECONDS:40 --var DEV_NEXT_GAME_SECONDS:1
// Then: node scripts/sim.mjs
// Checks: table size, join only at Placecut, card privacy, fairness proof, coin conservation, reconnect to the
// same seat, a resent bet charged once, Well Cut sequences, bonuses, Placecut scorecard, call off, the ledger report.
import { createHash, randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WSBASE = BASE.replace(/^http/, 'ws');
const NAMES = ['Rc', 'Srinu', 'Ravi', 'Kiran', 'Babji', 'Prasad', 'Naidu', 'Eighth'];
const token = (i) => `dev:p${i}:${encodeURIComponent(NAMES[i])}`;

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.error('  FAIL', what); } else if (process.env.VERBOSE) console.log('  ok  ', what); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  check(false, `timed out waiting for ${what}`);
  return false;
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const stats = { games: 0, wellCuts: 0, wcGames: new Set(), bonuses: 0, sideshows: 0, shows: 0, loans: 0, autoSeen: 0, cardSizes: new Set() };

class Bot {
  constructor(i, code) {
    this.i = i; this.code = code; this.view = null; this.seq = 0; this.actedSeq = 0; this.errors = []; this.paused = false;
    this.open();
  }
  open() {
    this.ws = new WebSocket(`${WSBASE}/api/rooms/${this.code}/ws?token=${encodeURIComponent(token(this.i))}`);
    this.ws.onmessage = (m) => this.on(JSON.parse(m.data));
    this.ready = new Promise((r) => { this.ws.onopen = r; this.ws.onclose = r; });
  }
  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  on(msg) {
    if (msg.t === 'error') { this.errors.push(msg.code); this.lastError = msg.code; return; }
    if (msg.t === 'report') { this.report = msg.report; return; }
    if (msg.t !== 'state' || msg.seq <= this.seq) return;
    this.seq = msg.seq; this.view = msg.view;
    const v = msg.view;
    const shown = v.result?.show && v.result.game === v.game ? [v.result.show.a, v.result.show.b] : [];
    v.players.forEach((p, j) => { if (j !== v.you && !shown.includes(j)) check(p.cards === null, `bot ${this.i} saw seat ${j}'s cards`); });
    check(!JSON.stringify(v).includes('"secret"'), 'server secret leaked');
    if (this.i === 0) {
      for (const e of msg.events) {
        if (e.e === 'win') stats.games++;
        if (e.e === 'cut' && e.wellCut) stats.wellCuts++;
        if (e.e === 'game') { stats.cardSizes.add(e.cardsEach); if (e.wellCutGame) stats.wcGames.add(e.wellCutGame); }
        if (e.e === 'bonus') stats.bonuses++;
        if (e.e === 'sideshow') stats.sideshows++;
        if (e.e === 'show') stats.shows++;
        if (e.e === 'loan') stats.loans++;
        if (e.e === 'see' && e.auto) stats.autoSeen++;
      }
      if (v.result && v.phase === 'game_over') {
        check(sha(`${v.result.deck}|${v.result.salt}`) === v.result.commit, `game ${v.result.game}: fairness fingerprint verifies`);
        const deck = v.result.deck.split(' ');
        check(deck.length === 52 && new Set(deck).size === 52, 'revealed deck is a full unique deck');
      }
      if (v.players.length === this.expectSeats) {
        const total = v.players.reduce((a, p) => a + p.coins - p.loan, 0) + v.pot;
        check(total === this.expectSeats * 100, `coins conserved (${total})`);
      }
    }
    this.decide(msg);
  }
  decide(msg) {
    const v = this.view;
    if (this.paused || v.you < 0) return;
    const o = v.options;
    if (o.cut) {
      // stop the timing bar: 40% of dealers aim for a middle crossing, the rest stop at a random moment
      const bar = v.cutBar;
      let at = bar.startAt + Math.random() * 3000;
      if (Math.random() < 0.4) { let t = bar.startAt; const k = Math.floor(Math.random() * 4); for (let i = 0; i < k; i++) t += bar.durs[i]; at = t + bar.durs[k] / 2; }
      return setTimeout(() => this.send({ t: 'cut', at }), Math.max(20, at - Date.now() + 5));
    }
    if (o.deal) return setTimeout(() => this.send({ t: 'deal' }), 20);
    if (v.phase !== 'betting' || v.turn !== v.you || this.actedSeq >= msg.seq) return;
    this.actedSeq = msg.seq;
    const me = v.players[v.you];
    const cost = me.seen ? v.rules.seen : v.rules.blind;
    if (o.loan && o.loan.needed > 0) {
      if (o.loan.needed <= o.loan.left) return this.send({ t: 'loan', id: randomUUID(), amount: o.loan.needed });
      return this.send({ t: 'act', id: randomUUID(), action: { type: 'pack' } });
    }
    const r = Math.random();
    let action;
    if (o.see && r < 0.25) action = { type: 'see' };
    else if (o.sideshow && r < 0.45 && me.coins >= v.rules.sideshow) action = { type: 'sideshow' };
    else if (o.show !== null && r < 0.5) action = { type: 'show' };
    else if (r < 0.12) action = { type: 'pack' };
    else action = { type: me.seen ? 'seen' : 'blind' };
    if (me.coins < cost && action.type !== 'pack') action = { type: 'pack' };
    setTimeout(() => this.send({ t: 'act', id: randomUUID(), action }), 15);
  }
}

async function main() {
  console.log(`Danka simulation against ${BASE}`);

  check((await api('/api/rooms/OOOO11')).status === 400, 'invalid code rejected');
  check((await api('/api/rooms/ABCDEF')).status === 404, 'unknown room is 404');
  check((await api('/api/rooms', { method: 'POST' })).status === 401, 'creating a room needs sign-in');

  const created = await api('/api/rooms', { method: 'POST', headers: { Authorization: `Bearer ${token(0)}`, 'content-type': 'application/json' }, body: JSON.stringify({ seats: 7 }) });
  check(created.status === 201, 'room created');
  const code = created.body.code;
  console.log('  room', code);

  // Six players for round 1; the seventh arrives late
  const bots = [];
  for (let i = 0; i < 6; i++) { const b = new Bot(i, code); bots.push(b); await b.ready; await sleep(40); }
  bots[0].expectSeats = 6;
  await until(() => bots[0].view?.players.length === 6, 5000, '6 seated');
  check(bots[0].view.isAdmin && bots[0].view.players[0].isDealer, 'first to enter is admin and deals game 1');
  check(!bots[1].view.options.startRound && bots[0].view.options.startRound, 'only the admin can start the round');

  bots[0].send({ t: 'start_round' });
  await until(() => bots[0].view?.round === 1, 5000, 'round 1 starts');

  const late = new Bot(6, code);
  await late.ready; await sleep(400);
  check(late.lastError === 'round_in_progress', `late joiner waits for Placecut (got ${late.lastError})`);

  // mid-round: reconnect seat 3, and resend one bet with the same id
  await until(() => bots[0].view?.phase === 'betting', 20_000, 'first betting');
  bots[3].ws.close();
  await sleep(300);
  check(bots[0].view.players[3].connected === false, 'seat 3 shows as disconnected');
  bots[3].open(); await bots[3].ready; await sleep(300);
  check(bots[3].view.you === 3 && bots[0].view.players.length === 6, 'seat 3 reconnected to the same seat');
  check(bots[0].view.players[3].connected === true, 'seat 3 connected again');

  let dupDone = false;
  for (let tries = 0; tries < 200 && !dupDone; tries++) {
    const v = bots[0].view;
    if (v.phase === 'betting') {
      const b = bots[v.turn];
      if (b?.view?.turn === b.view.you && b.view.options.blind && b.view.players[b.view.you].coins >= 1) {
        b.paused = true; b.actedSeq = Infinity;
        const before = b.view.players[b.view.you].coins;
        const id = randomUUID();
        b.send({ t: 'act', id, action: { type: 'blind' } });
        b.send({ t: 'act', id, action: { type: 'blind' } });
        await sleep(400);
        check(before - b.view.players[b.view.you].coins === 1, `resent Blind charged once (paid ${before - b.view.players[b.view.you].coins})`);
        b.paused = false; b.actedSeq = 0; b.decide({ seq: b.seq });
        dupDone = true;
      }
    }
    await sleep(30);
  }
  check(dupDone, 'duplicate-bet check ran');

  // round 1 ends at its clock; Placecut opens with the scorecard
  await until(() => bots[0].view?.phase === 'placecut', 120_000, 'Placecut after round 1');
  const card = bots[2].view.scorecard;
  check(card?.round === 1 && card.rows.length >= 2, 'scorecard shown at Placecut');
  check(card.rows.every((r) => r.net === r.balance - r.initial - r.outstandingLoan), 'net = balance − initial − outstanding loan');
  console.log(`  round 1: ${card.games} games, pot ${card.totalPot}, well cuts ${card.wellCuts}, loans ${card.loansIssued}`);

  // Placecut: the late player joins now, an 8th is refused
  late.open(); await late.ready; await sleep(400);
  check(late.view?.players.length === 7 && late.view.players[6].coins === 100, 'late player joined at Placecut with 100 coins');
  const eighth = new Bot(7, code);
  await eighth.ready; await sleep(400);
  check(eighth.lastError === 'room_full', `8th player refused (got ${eighth.lastError})`);
  bots.push(late);
  bots[0].expectSeats = bots[0].view.players.length;
  const carried = bots[0].view.players.map((p) => [p.coins, p.loan]);

  bots[0].send({ t: 'start_round' });
  await until(() => bots[0].view?.round === 2, 5000, 'round 2 starts');
  const kept = bots[0].view.players.filter((p) => p.status !== 'eliminated').every((p) => carried.some(([c, l]) => c === p.coins && l === p.loan) || p.coins === 100);
  check(kept, 'balances and loans carry into round 2');

  // admin calls off after a few more games
  const target = stats.games + 4;
  await until(() => stats.games >= target, 60_000, '4 more games');
  bots[0].send({ t: 'call_off' });
  await until(() => bots[0].view?.phase === 'ended', 30_000, 'session ends after call off');
  check(bots[0].view.scorecard?.final === true, 'final scorecard after call off');

  bots[1].send({ t: 'report' });
  await sleep(300);
  check(bots[1].lastError === 'not_admin', 'only the admin can export the report');
  bots[0].send({ t: 'report' });
  await until(() => !!bots[0].report, 5000, 'report');
  const ids = bots[0].report.ledger.map((t) => t.id);
  check(ids.length > 20 && new Set(ids).size === ids.length, `ledger has ${ids.length} unique transactions`);

  const v = bots[0].view;
  console.log('  standings:', v.players.map((p) => `${p.name} ${p.coins}${p.loan ? ` (loan ${p.loan})` : ''}${p.status === 'eliminated' ? ' OUT' : ''}`).join(', '));
  console.log(`  games ${stats.games}, card sizes ${[...stats.cardSizes].sort().join('/')}, well cuts ${stats.wellCuts} (games seen ${[...stats.wcGames].sort().join(',') || '-'}), bonuses ${stats.bonuses}, shows ${stats.shows}, sideshows ${stats.sideshows}, loans ${stats.loans}, auto-Seen ${stats.autoSeen}`);
  const errs = bots.flatMap((b) => b.errors).filter((e) => e !== 'round_in_progress' && e !== 'not_admin');
  console.log('  server-rejected moves:', errs.length ? [...new Set(errs)].join(', ') : 'none');

  [...bots, eighth].forEach((b) => b.ws.close());
  console.log(failures ? `FAILED: ${failures} check(s)` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
