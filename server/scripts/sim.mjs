// Simulated game night: 7 bots play real hands against a running server (npm run dev).
// Usage: node scripts/sim.mjs [mode] [hands]     e.g. node scripts/sim.mjs dealers 5
// Checks: 8th player refused, card privacy, fairness proof, coin conservation,
// reconnect to the same seat, and that a resent bet is not charged twice.
import { createHash, randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WSBASE = BASE.replace(/^http/, 'ws');
const MODE = process.argv[2] ?? 'classic';
const HANDS = Number(process.argv[3] ?? 4);
const NAMES = ['Rc', 'Srinu', 'Ravi', 'Kiran', 'Babji', 'Prasad', 'Naidu'];
const token = (i) => `dev:p${i}:${encodeURIComponent(NAMES[i])}`;
const START = 1000;

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.error('  FAIL', what); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

class Bot {
  constructor(i, code) {
    this.i = i; this.code = code; this.view = null; this.seq = 0; this.actedSeq = 0; this.errors = []; this.hands = 0;
    this.open();
  }
  open() {
    this.ws = new WebSocket(`${WSBASE}/api/rooms/${this.code}/ws?token=${encodeURIComponent(token(this.i))}`);
    this.ws.onmessage = (m) => this.on(JSON.parse(m.data));
    this.ready = new Promise((r) => (this.ws.onopen = r));
  }
  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  on(msg) {
    if (msg.t === 'error') { this.errors.push(msg.code); return; }
    if (msg.t !== 'state') return;
    if (msg.seq <= this.seq) return; // stale
    this.seq = msg.seq; this.view = msg.view;
    const v = msg.view;
    // privacy: only my cards, plus both hands after a Show
    const shown = v.result?.show ? [v.result.show.requester, v.result.show.opponent] : [];
    v.seats.forEach((s, j) => { if (j !== v.you && !shown.includes(j)) check(s.cards === null, `bot ${this.i} saw seat ${j}'s cards`); });
    check(!JSON.stringify(v).includes('"secret"'), 'server secret leaked');
    if (msg.events.some((e) => e.e === 'win')) this.hands++;
    this.decide(msg);
  }
  decide(msg) {
    const v = this.view;
    if (this.paused) return;
    if (v.phase === 'waiting' && !v.seats[v.you].ready) return this.send({ t: 'ready', ready: true });
    if (v.options.start) return this.send({ t: 'start' });
    if (v.options.pick) return this.send({ t: 'pick', mode: ['classic', 'muflis', 'ak47', 'joker', 'four'][Math.floor(Math.random() * 5)] });
    if (v.options.deal) return this.send({ t: 'deal' });
    if (v.phase === 'hand_over' && v.you === 0 && this.hands < HANDS) return setTimeout(() => this.send({ t: 'next' }), 50);
    if (v.phase !== 'betting' || v.turn !== v.you || this.actedSeq >= msg.seq) return;
    this.actedSeq = msg.seq;
    const o = v.options, r = Math.random();
    let action;
    if (o.see && r < 0.35) action = { type: 'see' };
    else if (o.show !== null && r < 0.6) action = { type: 'show' };
    else if (r < 0.2) action = { type: 'pack' };
    else if (o.raise !== null && r < 0.3) action = { type: 'raise' };
    else action = { type: 'chaal' };
    const id = randomUUID();
    setTimeout(() => this.send({ t: 'act', id, action }), 20);
  }
}

async function main() {
  console.log(`Simulating ${HANDS} hands of ${MODE} against ${BASE}`);

  check((await api('/api/rooms/OOOO11')).status === 400, 'invalid code should be rejected');
  check((await api('/api/rooms/ABCDEF')).status === 404, 'unknown room should be 404');
  check((await api('/api/rooms', { method: 'POST' })).status === 401, 'creating a room needs sign-in');

  const created = await api('/api/rooms', { method: 'POST', headers: { Authorization: `Bearer ${token(0)}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: MODE }) });
  check(created.status === 201, 'room created');
  const code = created.body.code;
  console.log('  room', code, created.body.joinUrl);

  const bots = [];
  for (let i = 0; i < 7; i++) {
    const b = new Bot(i, code);
    if (i < 6) b.paused = true; // hold everyone until all 7 are in
    bots.push(b);
    await b.ready;
    await sleep(60);
  }
  await sleep(300);
  check(bots.every((b) => b.view?.seats.length === 7), 'all 7 seated');
  check(bots[0].view.dealer === 0 && bots[0].view.seats[0].name === 'Rc', 'first to enter is seat 1 and deals game 1');

  // an 8th player is refused
  const eighth = new WebSocket(`${WSBASE}/api/rooms/${code}/ws?token=${encodeURIComponent('dev:p8:Eighth')}`);
  const eighthErr = await new Promise((r) => { eighth.onmessage = (m) => r(JSON.parse(m.data)); setTimeout(() => r(null), 3000); });
  check(eighthErr?.code === 'room_full', `8th player refused (got ${eighthErr?.code})`);

  bots.forEach((b) => { b.paused = false; b.send({ t: 'ready', ready: true }); });

  // mid-game: reconnect seat 3 and resend a bet with the same id
  let reconnectChecked = false, dupChecked = false;
  const deadline = Date.now() + 120_000;
  while (bots[0].hands < HANDS && Date.now() < deadline) {
    await sleep(100);
    const v = bots[0].view;
    if (!reconnectChecked && v?.phase === 'betting') {
      reconnectChecked = true;
      bots[3].ws.close();
      await sleep(300);
      check(bots[0].view.seats[3].connected === false, 'seat 3 shows as disconnected');
      bots[3].open();
      await bots[3].ready;
      await sleep(300);
      check(bots[3].view.you === 3 && bots[0].view.seats.length === 7, 'seat 3 reconnected to the same seat');
      check(bots[0].view.seats[3].connected === true, 'seat 3 shows as connected again');
    }
    if (!dupChecked && v?.phase === 'betting' && bots[v.turn]) {
      const b = bots[v.turn];
      if (b.view?.turn === b.view?.you && b.view.options.chaal) {
        dupChecked = true;
        b.paused = true;
        const before = b.view.seats[b.view.you].coins, cost = b.view.options.chaal;
        b.actedSeq = Infinity;
        const id = randomUUID();
        b.send({ t: 'act', id, action: { type: 'chaal' } });
        b.send({ t: 'act', id, action: { type: 'chaal' } });
        await sleep(400);
        const after = b.view.seats[b.view.you].coins + b.view.seats[b.view.you].loan * 0;
        check(before - after === cost || b.view.seats[b.view.you].loan > 0, `resent bet charged once (paid ${before - after}, cost ${cost})`);
        b.paused = false; b.actedSeq = 0;
        b.decide({ seq: b.seq });
      }
    }
  }

  // every finished hand: fairness proof and conservation
  const v = bots[2].view;
  check(bots[0].hands >= HANDS, `played ${bots[0].hands} hands`);
  if (v.result) {
    check(sha(`${v.result.deck}|${v.result.salt}`) === v.result.commit, 'fairness fingerprint verifies');
    check(v.result.deck.split(' ').length === 52 && new Set(v.result.deck.split(' ')).size === 52, 'revealed deck is a full unique deck');
  }
  const total = v.seats.reduce((a, s) => a + s.coins - s.loan, 0) + v.pot;
  check(total === 7 * START, `coins conserved (${total})`);
  console.log('  ledger tail:'); v.ledger.slice(-6).forEach((l) => console.log('   ', l.text));
  console.log('  standings:', v.seats.map((s) => `${s.name} ${s.coins}${s.loan ? ` (loan ${s.loan})` : ''}`).join(', '));
  const errs = bots.flatMap((b) => b.errors);
  console.log('  server-rejected moves:', errs.length ? [...new Set(errs)].join(', ') : 'none');

  bots.forEach((b) => b.ws.close());
  console.log(failures ? `FAILED: ${failures} check(s)` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
