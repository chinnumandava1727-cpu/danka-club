import { describe, expect, it } from 'vitest';
import {
  DANKA_RULES, act, answerPlayerLoan, commitmentInput, createRoom, deckString, freshDeck, handStrength, join, needsDeck, newBot, nextBotTask,
  parseCard, prepareDeck, runBot, sha256Hex, shuffle, startGame, viewFor, GameError, type State,
} from '../src';

const cards = (s: string) => s.split(' ').map(parseCard);

async function shuffleIn(st: State, now: number) {
  const deck = shuffle(freshDeck());
  prepareDeck(st, deck, 's', await sha256Hex(commitmentInput(deckString(deck), 's')), now);
}

/** One person (the admin) and `bots` computer players play `games` games; the person plays simply. */
async function tournament(bots: number, games: number, rules = DANKA_RULES) {
  let now = 1_700_000_000_000;
  const st = createRoom({ rules: { ...rules, wellCutSequence: [...rules.wellCutSequence] }, admin: { uid: 'me', name: 'Rc' }, now });
  for (let k = 0; k < bots; k++) { const b = newBot(st); join(st, b.uid, b.name, now); }
  startGame(st, 'me', now);
  let played = 0, steps = 0;
  const total = () => st.players.reduce((a, p) => a + p.coins - p.loan, 0) + st.pot;
  const start = total();
  while (played < games && steps++ < 200_000) {
    if (needsDeck(st)) { await shuffleIn(st, now); continue; }
    const ask = st.requests.find((r) => r.to === 'me');
    if (ask) { answerPlayerLoan(st, 'me', ask.id, Math.random() < 0.5 && st.players[0].coins >= ask.amount, now); continue; }
    const task = nextBotTask(st, now);
    if (task) {
      now = Math.max(now, task.at);
      const ev = runBot(st, task.uid, now);
      if (!ev.length) now += 1000; // waiting for a loan answer
      continue;
    }
    if (st.phase === 'game_over') { played++; now += 3000; startGame(st, 'me', now); continue; }
    if (st.phase === 'placecut') {
      now += 1000;
      // with too few players able to pay, wait for the broke computer players to borrow
      try { startGame(st, 'me', now); } catch (e) { if (!(e instanceof GameError)) throw e; now += 10_000; }
      continue;
    }
    // the person's move
    const v = viewFor(st, 'me');
    if (v.options.cut) cut0(st, now);
    else if (v.options.deal) deal0(st, now);
    else if (st.turn === 0) {
      const o = v.options;
      try {
        if (o.blind) act(st, 'me', { type: Math.random() < 0.3 ? 'pack' : 'blind' }, now);
        else if (o.seen) act(st, 'me', { type: Math.random() < 0.4 ? 'pack' : 'seen' }, now);
        else act(st, 'me', { type: 'pack' }, now);
      } catch (e) { if (e instanceof GameError) act(st, 'me', { type: 'pack' }, now); else throw e; }
    } else now += 500;
    expect(total()).toBe(start);
  }
  return { st, played, steps };
}
import { cut, deal } from '../src';
const cut0 = (st: State, now: number) => cut(st, 'me', now, now);
const deal0 = (st: State, now: number) => deal(st, 'me', now);

describe('computer players', () => {
  it('rate hands sensibly in every game size', () => {
    expect(handStrength(cards('As Ah Ad'))).toBe(1);
    expect(handStrength(cards('4s 5s 6s'))).toBeGreaterThan(handStrength(cards('4s 5h 6d')));
    expect(handStrength(cards('4s 5h 6d'))).toBeGreaterThan(handStrength(cards('Kd 7d 2d')));
    expect(handStrength(cards('Kd 7d 2d'))).toBeGreaterThan(handStrength(cards('Qs Qh 3c')));
    expect(handStrength(cards('Qs Qh 3c'))).toBeGreaterThan(handStrength(cards('As Jd 4h')));
    expect(handStrength(cards('2c 2d'))).toBeGreaterThan(handStrength(cards('As Ah')));
    expect(handStrength(cards('9s 9h 9d 9c'))).toBe(1);
    expect(handStrength(cards('As'))).toBeGreaterThan(handStrength(cards('2c')));
  });

  it('get their own names and seats', () => {
    const st = createRoom({ rules: { ...DANKA_RULES }, admin: { uid: 'me', name: 'Rc' }, now: 0 });
    for (let k = 0; k < 3; k++) { const b = newBot(st); join(st, b.uid, b.name, 0); }
    expect(st.players.map((p) => p.name)).toEqual(['Rc', 'Chitti (CPU)', 'Bujji (CPU)', 'Pandu (CPU)']);
    expect(viewFor(st, 'me').players.map((p) => p.bot)).toEqual([false, true, true, true]);
  });

  it('play whole tournaments with one person: every game finishes and coins are conserved', async () => {
    for (const n of [1, 3, 6, 9]) {
      const { played } = await tournament(n, 40);
      expect(played, `${n} computer players`).toBe(40);
    }
  });

  it('use bank loans and player loans when they run out of coins', async () => {
    const { st, played } = await tournament(5, 120, { ...DANKA_RULES, startingCoins: 6, maxLoan: 4 });
    expect(played).toBe(120);
    expect(st.bankLoansTotal).toBeGreaterThan(0);
    expect(st.p2pLog.length).toBeGreaterThan(0);
  });
});
