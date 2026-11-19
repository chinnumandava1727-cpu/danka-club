import { beforeEach, describe, expect, it } from 'vitest';
import {
  GameError, STAND_IN_RULES, act, activeSeats, commitmentInput, createGame, deal, deckString, freshDeck,
  join, nextHand, onDeadline, parseCard, pickMode, prepareDeal, setReady, sha256Hex, shuffle, start,
  type Card, type GameState, type SessionMode, viewFor, verifyCommitment,
} from '../src';

const NAMES = ['Rc', 'Srinu', 'Ravi', 'Kiran', 'Babji', 'Prasad', 'Naidu'];
const uid = (i: number) => `u${i}`;
let now = 1_700_000_000_000;

function table(mode: SessionMode = 'classic'): GameState {
  const st = createGame({ rules: { ...STAND_IN_RULES }, sessionMode: mode, admin: { uid: uid(0), name: NAMES[0] }, now });
  for (let i = 1; i < 7; i++) join(st, uid(i), NAMES[i], now);
  for (let i = 0; i < 7; i++) setReady(st, uid(i), true);
  start(st, uid(0), now);
  return st;
}

async function shuffleIn(st: GameState, deck: Card[] = shuffle(freshDeck())) {
  const salt = 'testsalt';
  const commit = await sha256Hex(commitmentInput(deckString(deck), salt));
  prepareDeal(st, deck, salt, commit, now);
  return { deck, salt, commit };
}

/** Total coins in the system: everyone's coins + pot − loans must equal 7 × starting coins. */
const conserved = (st: GameState) => st.seats.reduce((a, s) => a + s.coins - s.loan, 0) + st.pot === 7 * STAND_IN_RULES.startingCoins;

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

beforeEach(() => {
  now = 1_700_000_000_000;
});

describe('rooms', () => {
  it('seats players in entry order and refuses an 8th', () => {
    const st = createGame({ rules: { ...STAND_IN_RULES }, sessionMode: 'classic', admin: { uid: 'a', name: 'Rc' }, now });
    for (let i = 1; i < 7; i++) expect(join(st, `p${i}`, `P${i}`, now).seat).toBe(i);
    expectCode(() => join(st, 'p8', 'Eighth', now), 'room_full');
  });

  it('returns a reconnecting player to the same seat', () => {
    const st = table();
    const r = join(st, uid(3), 'Kiran again', now);
    expect(r.seat).toBe(3);
    expect(st.seats).toHaveLength(7);
    expect(st.seats[3].name).toBe('Kiran');
  });

  it('starts with 2 or more ready players, only by the admin', () => {
    const st = createGame({ rules: { ...STAND_IN_RULES }, sessionMode: 'classic', admin: { uid: 'a', name: 'Rc' }, now });
    st.seats[0].ready = true;
    expectCode(() => start(st, 'a', now), 'not_enough_players');
    join(st, 'p1', 'P1', now);
    expectCode(() => start(st, 'a', now), 'not_ready');
    st.seats.forEach((s) => (s.ready = true));
    expectCode(() => start(st, 'p1', now), 'not_admin');
    start(st, 'a', now);
    expect(st.phase).toBe('dealing');
  });

  it('plays a full hand with 3 players', async () => {
    const st = createGame({ rules: { ...STAND_IN_RULES }, sessionMode: 'classic', admin: { uid: 'a', name: 'Rc' }, now });
    join(st, 'b', 'B', now); join(st, 'c', 'C', now);
    st.seats.forEach((s) => (s.ready = true));
    start(st, 'a', now);
    await shuffleIn(st);
    expect(st.pot).toBe(30);
    expect(st.seats.every((s) => s.cards.length === 3)).toBe(true);
    deal(st, 'a', now);
    expect(st.turn).toBe(1);
    act(st, 'b', { type: 'chaal' }, now);
    act(st, 'c', { type: 'pack' }, now);
    act(st, 'a', { type: 'show' }, now);
    expect(st.phase).toBe('hand_over');
    expect(st.seats.reduce((x, s) => x + s.coins - s.loan, 0)).toBe(3 * STAND_IN_RULES.startingCoins);
  });

  it('lets a late joiner in mid-hand; they sit out and are dealt in next hand', async () => {
    const st = createGame({ rules: { ...STAND_IN_RULES }, sessionMode: 'classic', admin: { uid: 'a', name: 'Rc' }, now });
    join(st, 'b', 'B', now);
    st.seats.forEach((s) => (s.ready = true));
    start(st, 'a', now);
    await shuffleIn(st);
    deal(st, 'a', now);
    const r = join(st, 'late', 'Late', now);
    expect(r.seat).toBe(2);
    expect(st.seats[2].status).toBe('packed');
    expect(st.seats[2].coins).toBe(STAND_IN_RULES.startingCoins);
    expect(viewFor(st, 'late').waitingForNextHand).toBe(true);
    act(st, 'b', { type: 'pack' }, now);
    expect(st.phase).toBe('hand_over');
    nextHand(st, now);
    await shuffleIn(st);
    expect(st.seats[2].cards).toHaveLength(3);
    expect(st.seats[2].status).toBe('in');
  });

  it('does not allow late joining in Tournament Night', async () => {
    const st = createGame({ rules: { ...STAND_IN_RULES }, sessionMode: 'tour', admin: { uid: 'a', name: 'Rc' }, now });
    join(st, 'b', 'B', now);
    st.seats.forEach((s) => (s.ready = true));
    start(st, 'a', now);
    expectCode(() => join(st, 'late', 'Late', now), 'game_started');
  });

  it('the first player to enter deals game 1', () => {
    const st = table();
    expect(st.dealer).toBe(0);
  });
});

describe('a hand', () => {
  it('collects the boot, locks cards clockwise from the dealer’s left, and starts with that player', async () => {
    const st = table();
    const { deck } = await shuffleIn(st);
    expect(st.pot).toBe(70);
    // first card goes to seat 1 (dealer's left), the 8th card to seat 1 again
    expect(st.seats[1].cards[0]).toEqual(deck[0]);
    expect(st.seats[0].cards[0]).toEqual(deck[6]);
    expect(st.seats[1].cards[1]).toEqual(deck[7]);
    expectCode(() => deal(st, uid(4), now), 'not_dealer');
    deal(st, uid(0), now);
    expect(st.phase).toBe('betting');
    expect(st.turn).toBe(1);
  });

  it('blind bets the stake, seen bets double, raises double the stake', async () => {
    const st = table();
    await shuffleIn(st);
    deal(st, uid(0), now);
    act(st, uid(1), { type: 'chaal' }, now);
    expect(st.seats[1].coins).toBe(1000 - 10 - 10);
    act(st, uid(2), { type: 'see' }, now);
    act(st, uid(2), { type: 'chaal' }, now);
    expect(st.seats[2].coins).toBe(1000 - 10 - 20);
    act(st, uid(3), { type: 'raise' }, now);
    expect(st.stake).toBe(20);
    expect(st.seats[3].coins).toBe(1000 - 10 - 20);
    expect(conserved(st)).toBe(true);
  });

  it('rejects moves out of turn', async () => {
    const st = table();
    await shuffleIn(st);
    deal(st, uid(0), now);
    expectCode(() => act(st, uid(4), { type: 'chaal' }, now), 'not_your_turn');
  });

  it('ends when everyone else packs: winner takes the pot and deals next', async () => {
    const st = table();
    await shuffleIn(st);
    deal(st, uid(0), now);
    for (const i of [1, 2, 3, 4, 5, 6]) act(st, uid(i), { type: 'pack' }, now);
    expect(st.phase).toBe('hand_over');
    expect(st.result?.winner).toBe(0);
    expect(st.seats[0].coins).toBe(1000 - 10 + 70);
    expect(st.dealer).toBe(0);
    expect(conserved(st)).toBe(true);
  });

  it('resolves a Show; equal hands go against the player who asked', async () => {
    const st = table();
    // seat 1 gets As Ah Ad style trail? build a deck where seats 1 and 2 hold identical-value hands
    const deck = freshDeck();
    const pick = (c: string) => deck.splice(deck.findIndex((d) => d.r === parseCard(c).r && d.s === parseCard(c).s), 1)[0];
    const s1 = ['Ks', 'Qs', 'Js'].map(pick); // pure sequence
    const s2 = ['Kh', 'Qh', 'Jh'].map(pick); // identical value
    const rest = shuffle(deck);
    const ordered: Card[] = [];
    // deal order is seats 1..6 then 0, three rounds
    for (let r = 0; r < 3; r++) for (let seat = 1; seat <= 7; seat++) {
      const s = seat % 7;
      ordered.push(s === 1 ? s1[r] : s === 2 ? s2[r] : rest.pop()!);
    }
    ordered.push(...rest);
    await shuffleIn(st, ordered);
    deal(st, uid(0), now);
    act(st, uid(1), { type: 'chaal' }, now);
    act(st, uid(2), { type: 'chaal' }, now);
    for (const i of [3, 4, 5, 6, 0]) act(st, uid(i), { type: 'pack' }, now);
    expect(activeSeats(st)).toEqual([1, 2]);
    expect(st.turn).toBe(1);
    act(st, uid(1), { type: 'show' }, now);
    expect(st.result?.reason).toBe('show');
    expect(st.result?.winner).toBe(2); // tie: requester (seat 1) loses
    expect(conserved(st)).toBe(true);
  });

  it('auto-packs on timeout, auto-deals, and moves to the next hand', async () => {
    const st = table();
    await shuffleIn(st);
    now += STAND_IN_RULES.autoDealSeconds * 1000;
    onDeadline(st, now);
    expect(st.phase).toBe('betting');
    now += STAND_IN_RULES.turnSeconds * 1000;
    const ev = onDeadline(st, now);
    expect(ev.find((e) => e.e === 'pack')).toMatchObject({ seat: 1, reason: 'timeout' });
    for (const i of [2, 3, 4, 5, 6]) act(st, uid(i), { type: 'pack' }, now);
    expect(st.phase).toBe('hand_over');
    now += STAND_IN_RULES.nextHandSeconds * 1000;
    onDeadline(st, now);
    expect(st.hand).toBe(2);
    expect(st.phase).toBe('dealing');
  });
});

describe('privacy and fairness', () => {
  it('never shows another player’s cards before the hand ends', async () => {
    const st = table();
    await shuffleIn(st);
    deal(st, uid(0), now);
    const v = viewFor(st, uid(3));
    expect(v.seats[3].cards).toHaveLength(3);
    v.seats.forEach((s, i) => { if (i !== 3) expect(s.cards).toBeNull(); });
    expect(JSON.stringify(v)).not.toContain('testsalt');
    expect(v.result).toBeNull();
  });

  it('reveals the deck and salt after the hand so anyone can verify the fingerprint', async () => {
    const st = table();
    const { commit } = await shuffleIn(st);
    deal(st, uid(0), now);
    for (const i of [1, 2, 3, 4, 5, 6]) act(st, uid(i), { type: 'pack' }, now);
    const v = viewFor(st, uid(5));
    expect(v.result?.commit).toBe(commit);
    expect(await verifyCommitment(v.result!.commit, v.result!.deck, v.result!.salt)).toBe(true);
  });

  it('a dealer cannot deal before the server has locked the deck', () => {
    const st = table();
    expectCode(() => deal(st, uid(0), now), 'not_dealing');
  });
});

describe('modes', () => {
  it("Dealer's Choice: only the dealer picks; time-out picks Classic", () => {
    const st = table('dealers');
    expect(st.phase).toBe('picking');
    expectCode(() => pickMode(st, uid(2), 'muflis', now), 'not_dealer');
    pickMode(st, uid(0), 'muflis', now);
    expect(st.handMode).toBe('muflis');
    const st2 = table('dealers');
    now += STAND_IN_RULES.pickSeconds * 1000;
    onDeadline(st2, now);
    expect(st2.handMode).toBe('classic');
  });

  it('Best of Four deals four cards each', async () => {
    const st = table('four');
    await shuffleIn(st);
    expect(st.seats.every((s) => s.cards.length === 4)).toBe(true);
  });

  it('Joker Draw takes the wild rank from the undealt bottom card', async () => {
    const st = table('joker');
    const { deck } = await shuffleIn(st);
    expect(st.wild).toBe(deck[51].r);
  });

  it('gives a bank loan instead of letting a player go below zero', async () => {
    const st = table();
    st.seats[2].coins += st.seats[1].coins - 5; // move coins, don't destroy them
    st.seats[1].coins = 5;
    await shuffleIn(st);
    expect(st.seats[1].loan).toBe(STAND_IN_RULES.loanAmount);
    expect(st.seats[1].coins).toBeGreaterThanOrEqual(0);
    expect(conserved(st)).toBe(true);
  });

  it('Tournament: no loans, players who cannot pay the boot are out, last one standing wins', async () => {
    const st = table('tour');
    for (let i = 2; i < 7; i++) st.seats[i].coins = 0;
    st.seats[1].coins = 5;
    await shuffleIn(st); // hand 1 started before coins were cut; finish it
    deal(st, uid(0), now);
    act(st, uid(1), { type: 'pack' }, now);
    for (const i of [2, 3, 4, 5, 6]) if (st.phase === 'betting') act(st, uid(i), { type: 'pack' }, now);
    expect(st.seats.every((s) => s.loan === 0)).toBe(true);
    nextHand(st, now);
    expect(st.phase).toBe('session_over');
    expect(st.champion).toBe(0);
  });
});
