/**
 * DANKA CLUB rules tests. Numbers in test names refer to the "Mandatory testing before release"
 * list in section 20 of the group's rules.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DANKA_RULES, GameError, act, activeSeats, callOff, cardCode, commitmentInput, createRoom, cut, deal, dealOrder, deckString,
  freshDeck, join, leave, nextGame, onDeadline, parseCard, prepareDeck, setTimer, sha256Hex, shuffle, startGame, takeLoan,
  viewFor, barPosition, cutterSeat, requestPlayerLoan, answerPlayerLoan, cancelPlayerLoan, type Card, type State,
} from '../src';

const NAMES = ['Rc', 'Srinu', 'Ravi', 'Kiran', 'Babji', 'Prasad', 'Naidu', 'Suresh', 'Venky', 'Murali'];
const uid = (i: number) => `u${i}`;
let now = 1_700_000_000_000;
beforeEach(() => { now = 1_700_000_000_000; });

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

function room(n: number): State {
  const st = createRoom({ rules: { ...DANKA_RULES, wellCutSequence: [...DANKA_RULES.wellCutSequence] }, admin: { uid: uid(0), name: NAMES[0] }, now });
  for (let i = 1; i < n; i++) join(st, uid(i), NAMES[i], now);
  return st;
}

/** Deck that gives each listed seat exactly these cards, dealt round by round in the real order. */
function rig(st: State, want: Record<number, string[]>, cardsEach = st.cardsEach): Card[] {
  const order = dealOrder(st);
  const used = new Set(Object.values(want).flat());
  const rest = shuffle(freshDeck().filter((c) => !used.has(cardCode(c))));
  const deck: Card[] = [];
  for (let r = 0; r < cardsEach; r++) for (const i of order) deck.push(want[i]?.[r] ? parseCard(want[i][r]) : rest.pop()!);
  return [...deck, ...rest];
}

async function shuffleIn(st: State, deck: Card[] = shuffle(freshDeck())) {
  const salt = 'salt';
  prepareDeck(st, deck, salt, await sha256Hex(commitmentInput(deckString(deck), salt)), now);
}

/** Stop the slider at the top of the bar (a miss) or exactly in the middle of the first pass (a Well Cut). */
/** The player on the dealer's left stops the slider. */
const cutter = (st: State) => st.players[cutterSeat(st)].uid;
const cutMiss = (st: State, u: string | null = cutter(st)) => cut(st, u, st.cutBar!.startAt, now);
const cutWell = (st: State, u: string | null = cutter(st)) => cut(st, u, st.cutBar!.startAt + st.cutBar!.durs[0] / 2, now);
/** The moment in the first pass when the slider is at position p (0 top … 1 bottom). */
const timeAt = (st: State, p: number) => st.cutBar!.startAt + (Math.acos(1 - 2 * p) / Math.PI) * st.cutBar!.durs[0];

/** After a game the admin starts the next one (same 20-minute period). */
const next = (st: State) => { startGame(st, uid(0), now); };
/** Let the 20 minutes run out after the current game: the Placecut follows. */
const toPlacecut = (st: State) => { now = Math.max(now, st.roundEndsAt! + 1); nextGame(st, now); };

/** Start a round and get to betting without a Well Cut. */
async function toBetting(st: State, want: Record<number, string[]> = {}) {
  if (st.phase === 'lobby' || st.phase === 'placecut') startGame(st, uid(0), now);
  await shuffleIn(st, rig(st, want));
  if (st.phase === 'cutting') cutMiss(st);
  deal(st, st.dealerUid, now);
}

const a = (st: State, seat: number, type: 'see' | 'blind' | 'seen' | 'pack' | 'show' | 'sideshow') => act(st, uid(seat), { type }, now);
/** Coins never appear or vanish: balances − loans + pot = players × 100 (plus anyone who left). */
const conserved = (st: State, n: number) => st.players.reduce((s, p) => s + p.coins - p.loan, 0) + st.pot === n * 100;
/** Empty a player's purse and bank allowance by moving their coins to another player (coins stay conserved). */
const broke = (st: State, i: number, to: number) => {
  const p = st.players[i], add = 100 - p.loan; // takes the rest of the bank loan, then loses everything to `to`
  st.players[to].coins += p.coins + add; p.coins = 0; p.loan = 100;
};

describe('rooms (tests 1, 3, 27, 31, 33)', () => {
  it('1. creates a room, joins by code, seats up to 10 and refuses an 11th player', () => {
    const st = room(10);
    expect(st.players).toHaveLength(10);
    expectCode(() => join(st, 'u10', 'Eleventh', now), 'room_full');
  });

  it('10 players: a Well Cut deals 4 cards each (40 of the 52) round by round', async () => {
    const st = room(10);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    cutWell(st);
    expect(st.players.every((p) => p.cards.length === 4)).toBe(true);
    expect(new Set(st.players.flatMap((p) => p.cards.map(cardCode))).size).toBe(40);
  });

  it('23. every player starts with 100 coins, recorded in the ledger', () => {
    const st = room(5);
    expect(st.players.every((p) => p.coins === 100)).toBe(true);
    expect(st.ledger.filter((t) => t.type === 'initial').reduce((s, t) => s + t.amount, 0)).toBe(500);
  });

  it('3. the first person to enter is admin and deals the first game; the player on the left cuts', async () => {
    const st = room(4);
    startGame(st, uid(0), now);
    expect(st.dealerUid).toBe(uid(0));
    await shuffleIn(st);
    // the player on the dealer's left stops the Well Cut slider; the dealer only deals
    expect(viewFor(st, uid(1)).cutter).toBe(1);
    expect(viewFor(st, uid(1)).options.cut).toBe(true);
    expect(viewFor(st, uid(0)).options.cut).toBe(false);
    expectCode(() => cutMiss(st, uid(0)), 'not_cutter');
    expectCode(() => cutMiss(st, uid(2)), 'not_cutter');
    cutMiss(st, uid(1));
    expect(viewFor(st, uid(0)).options.deal).toBe(true);
    expectCode(() => deal(st, uid(1), now), 'not_dealer');
  });

  it('31. reconnecting returns you to your own seat', () => {
    const st = room(3);
    expect(join(st, uid(2), 'Ravi again', now).seat).toBe(2);
    expect(st.players).toHaveLength(3);
  });

  it('27. nobody joins or leaves during the 20 minutes; both are allowed at Placecut', async () => {
    const st = room(3);
    startGame(st, uid(0), now);
    expectCode(() => join(st, 'late', 'Late', now), 'round_in_progress');
    expectCode(() => leave(st, uid(1), now), 'round_in_progress');
    await shuffleIn(st);
    cutMiss(st); deal(st, uid(0), now);
    a(st, 1, 'pack'); a(st, 2, 'pack');
    expectCode(() => join(st, 'late', 'Late', now), 'round_in_progress'); // a game ended, but no Placecut yet
    toPlacecut(st);
    expect(st.phase).toBe('placecut');
    expect(join(st, 'late', 'Late', now).seat).toBe(3);
    expect(st.players[3].coins).toBe(100);
    leave(st, uid(1), now);
    expect(st.players.map((p) => p.name)).toEqual(['Rc', 'Ravi', 'Late']);
  });

  it('33. the admin cannot see other players’ cards', async () => {
    const st = room(4);
    await toBetting(st);
    const v = viewFor(st, uid(0));
    v.players.forEach((p, i) => { if (i !== 0) expect(p.cards).toBeNull(); });
    expect(JSON.stringify(v)).not.toContain('"secret"');
  });
});

describe('dealing and the Well Cut (tests 6–9)', () => {
  it('6. the dealer stops the timing bar; every phone sees the same bar while cutting, the result after', async () => {
    const st = room(7);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    const v = viewFor(st, uid(3));
    expect(v.cutBar).toEqual(st.cutBar);
    expect(v.cutBar!.startAt).toBe(now + DANKA_RULES.cutBarLeadMs);
    expect(v.lastCut).toBeNull();
    cutMiss(st);
    expect(viewFor(st, uid(0)).lastCut).toMatchObject({ players: 7, wellCut: false, pos: 0 });
    expect(viewFor(st, uid(0)).cutBar).toBeNull();
    expect(st.players.every((p) => p.cards.length === 3)).toBe(true);
  });

  it('7. Well Cut = stopping within 1.5% of the middle of the bar, on any pass', async () => {
    const cases: [number, boolean][] = [[0.5, true], [0.514, true], [0.486, true], [0.516, false], [0.484, false], [0.3, false], [0.95, false], [0, false]];
    for (const [p, wc] of cases) {
      const st = room(3);
      startGame(st, uid(0), now);
      await shuffleIn(st);
      cut(st, cutter(st), timeAt(st, p), now);
      expect(st.lastCut!.wellCut, `stopped at ${p}`).toBe(wc);
      expect(st.cardsEach).toBe(wc ? 4 : 3);
    }
    // the middle of the third pass (bottom → top) is a Well Cut too
    const st = room(2);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    const d = st.cutBar!.durs;
    cut(st, cutter(st), st.cutBar!.startAt + d[0] + d[1] + d[2] / 2, now);
    expect(st.lastCut!.wellCut).toBe(true);
  });

  it('7b. the slider changes speed every pass, speeds up, and eases fastest through the middle', async () => {
    const st = room(2);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    const bar = st.cutBar!;
    expect(new Set(bar.durs.slice(0, 10)).size).toBeGreaterThan(5);
    expect(bar.durs.slice(0, 5).reduce((a, b) => a + b) / 5).toBeGreaterThan(bar.durs.slice(20, 25).reduce((a, b) => a + b) / 5);
    expect(barPosition(bar, bar.startAt)).toBe(0);
    expect(barPosition(bar, bar.startAt + bar.durs[0])).toBeCloseTo(1, 6);
    const mid = barPosition(bar, bar.startAt + bar.durs[0] / 2 + 10) - barPosition(bar, bar.startAt + bar.durs[0] / 2);
    const end = barPosition(bar, bar.startAt + 10) - barPosition(bar, bar.startAt);
    expect(mid).toBeGreaterThan(end * 10);
  });

  it('7c. random stops land in the Well Cut zone rarely (about 2%)', async () => {
    const st = room(2);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    let hits = 0;
    const N = 20000;
    for (let k = 0; k < N; k++) if (Math.abs(barPosition(st.cutBar!, st.cutBar!.startAt + Math.random() * 15000) - 0.5) * 100 <= 1.5) hits++;
    expect(hits / N).toBeGreaterThan(0.01);
    expect(hits / N).toBeLessThan(0.035);
  });

  it('8. a Well Cut starts four compulsory games of 4, 3, 2 and 1 cards; the winner deals each; then normal play resumes', async () => {
    const st = room(3);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    cutWell(st);
    const sizes: number[] = [];
    const dealers: string[] = [];
    for (let g = 0; g < 4; g++) {
      if (g > 0) { next(st); await shuffleIn(st); }
      expect(st.phase).toBe('dealing'); // no cut inside the sequence
      sizes.push(st.cardsEach);
      expect(st.players.every((p) => p.cards.length === st.cardsEach)).toBe(true);
      dealers.push(st.dealerUid);
      deal(st, st.dealerUid, now);
      // the player to act packs, then the next packs: the third wins
      a(st, st.turn, 'pack'); a(st, st.turn, 'pack');
      expect(st.dealerUid).toBe(st.players[st.result!.winner].uid);
    }
    expect(sizes).toEqual([4, 3, 2, 1]);
    next(st);
    await shuffleIn(st);
    expect(st.phase).toBe('cutting');
    expect(st.cardsEach).toBe(3);
  });

  it('8b. the 20-minute clock cannot interrupt a Well Cut sequence', async () => {
    const st = room(2);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    cutWell(st); deal(st, uid(0), now);
    a(st, st.turn, 'pack');
    now = st.roundEndsAt! + 60_000;
    nextGame(st, now);
    expect(st.phase).toBe('shuffling'); // Well Cut game 2 still happens
    expect(st.cardsEach).toBe(3);
  });

  it('9. cards are dealt one at a time, round by round, from the dealer’s left', async () => {
    const st = room(4);
    startGame(st, uid(0), now);
    const deck = shuffle(freshDeck());
    await shuffleIn(st, deck);
    cutMiss(st);
    expect(st.players[1].cards[0]).toEqual(deck[0]);
    expect(st.players[2].cards[0]).toEqual(deck[1]);
    expect(st.players[0].cards[0]).toEqual(deck[3]);
    expect(st.players[1].cards[1]).toEqual(deck[4]);
  });

  it('4. the winner of every game becomes the next dealer', async () => {
    const st = room(3);
    await toBetting(st);
    a(st, 1, 'pack'); a(st, 2, 'pack');
    expect(st.dealerUid).toBe(uid(0));
    next(st);
    await shuffleIn(st);
    cutMiss(st); deal(st, uid(0), now);
    a(st, 1, 'pack'); a(st, 2, 'blind'); a(st, 0, 'pack');
    expect(st.dealerUid).toBe(uid(2));
  });
});

describe('Blind, Seen and Show (tests 14–17)', () => {
  it('Blind costs 1, Seen costs 2, there is no Chaal', async () => {
    const st = room(3);
    await toBetting(st);
    a(st, 1, 'blind');
    expect(st.players[1].coins).toBe(99);
    a(st, 2, 'see');
    a(st, 2, 'seen');
    expect(st.players[2].coins).toBe(98);
    expectCode(() => act(st, uid(0), { type: 'chaal' } as never, now), 'bad_action');
    expect(st.pot).toBe(3);
  });

  it('turns go one by one; moves out of turn are rejected', async () => {
    const st = room(3);
    await toBetting(st);
    expect(st.turn).toBe(1);
    expectCode(() => a(st, 2, 'blind'), 'not_your_turn');
  });

  it('14/15. Show only with two players left; priced automatically; a Blind player waits for the other to be Seen', async () => {
    const st = room(3);
    await toBetting(st);
    expectCode(() => a(st, 1, 'show'), 'show_not_allowed');
    a(st, 1, 'pack');
    expect(activeSeats(st)).toEqual([0, 2]);
    expectCode(() => a(st, 2, 'show'), 'blind_show'); // both still Blind
    a(st, 2, 'blind');
    a(st, 0, 'see');
    a(st, 0, 'seen');
    a(st, 2, 'show'); // seat 2 Blind, seat 0 Seen → Blind Show for 1 coin
    expect(st.ledger.filter((t) => t.type === 'show').at(-1)!.amount).toBe(-1);
    expect(st.result!.reason).toBe('show');
  });

  it('14b. a Seen Show costs 2', async () => {
    const st = room(2);
    await toBetting(st);
    a(st, 1, 'see');
    const before = st.players[1].coins;
    a(st, 1, 'show');
    const paid = st.ledger.filter((t) => t.type === 'show').at(-1)!;
    expect(paid.amount).toBe(-2);
    expect(before).toBe(100);
  });

  it('16/17. once everyone else is Seen, the last Blind player gets exactly 3 more Blind actions, then is shown their cards', async () => {
    const st = room(3);
    await toBetting(st);
    a(st, 1, 'see'); a(st, 2, 'see');
    // seat 1 to act; seat 0 is the only Blind player
    a(st, 1, 'seen'); a(st, 2, 'seen');
    expect(viewFor(st, uid(0)).players[0].extraBlindsLeft).toBe(3);
    a(st, 0, 'blind'); a(st, 1, 'seen'); a(st, 2, 'seen');
    a(st, 0, 'blind'); a(st, 1, 'seen'); a(st, 2, 'seen');
    expect(st.players[0].seen).toBe(false);
    a(st, 0, 'blind');
    expect(st.players[0].seen).toBe(true); // automatic reveal after the third
    a(st, 1, 'seen'); a(st, 2, 'seen');
    expectCode(() => a(st, 0, 'blind'), 'you_are_seen');
  });
});

describe('Blind/Seen rotation (corrected local rule)', () => {
  it('before anyone plays Seen, everyone may keep playing Blind; nobody is forced to open their cards', async () => {
    const st = room(5);
    await toBetting(st);
    for (let k = 0; k < 10; k++) {
      expect(viewFor(st, uid(st.turn)).options.mustSeen).toBe(false);
      a(st, st.turn, 'blind');
    }
    expect(st.players.every((p) => !p.seen)).toBe(true);
  });

  it("the document's example: after the first Seen, a Blind forces the next active player to play Seen", async () => {
    const st = room(7);
    await toBetting(st); // seat 1 acts first
    const P = (n: number) => n; // Player n = seat n (Player 1 = seat 1 …)
    a(st, P(1), 'see'); a(st, P(1), 'seen'); // Player 1: Seen → rotation rule activated
    expect(viewFor(st, uid(2)).options.mustSeen).toBe(false);
    a(st, P(2), 'blind'); // Player 2: Blind → Player 3 must play Seen
    expect(viewFor(st, uid(3)).options).toMatchObject({ mustSeen: true, blind: false, seen: true });
    expectCode(() => a(st, P(3), 'blind'), 'must_play_seen');
    a(st, P(3), 'seen'); // Player 3: Seen and continues → Player 4 chooses
    expect(st.players[3].seen).toBe(true);
    expect(viewFor(st, uid(4)).options).toMatchObject({ mustSeen: false, blind: true });
    a(st, P(4), 'blind'); // Player 4: Blind → Player 5 must play Seen
    expect(viewFor(st, uid(5)).options.mustSeen).toBe(true);
    a(st, P(5), 'pack'); // Player 5 folds → Player 6 must play Seen
    expect(st.turn).toBe(6);
    expect(viewFor(st, uid(6)).options.mustSeen).toBe(true);
    expectCode(() => a(st, P(6), 'blind'), 'must_play_seen');
  });

  it('folded players are skipped when finding the next active player', async () => {
    const st = room(5);
    await toBetting(st);
    a(st, 1, 'see'); a(st, 1, 'seen');
    a(st, 2, 'pack'); a(st, 3, 'blind'); a(st, 4, 'pack');
    expect(st.turn).toBe(0);
    expect(viewFor(st, uid(0)).options.mustSeen).toBe(true);
  });

  it('a new game starts without the rule until someone plays Seen again', async () => {
    const st = room(3);
    await toBetting(st);
    a(st, 1, 'see'); a(st, 1, 'seen'); a(st, 2, 'blind');
    expect(viewFor(st, uid(0)).options.mustSeen).toBe(true);
    a(st, 0, 'pack'); a(st, 1, 'pack');
    next(st); await shuffleIn(st); cutMiss(st); deal(st, st.dealerUid, now);
    a(st, st.turn, 'blind');
    expect(viewFor(st, uid(st.turn)).options.mustSeen).toBe(false);
  });

  it('with only two players left the restriction and the three-Blind limit are removed', async () => {
    const st = room(3);
    await toBetting(st);
    a(st, 1, 'see'); a(st, 1, 'seen');
    a(st, 2, 'pack');
    for (let k = 0; k < 12; k++) a(st, st.turn, st.players[st.turn].seen ? 'seen' : 'blind');
    expect(st.players[0].seen).toBe(false); // seat 0 stayed Blind the whole time
    expect(st.phase).toBe('betting');
  });
});

describe('Sideshow (tests 18–20)', () => {
  it('18. opens only when every active player is Seen', async () => {
    const st = room(4);
    await toBetting(st);
    a(st, 1, 'see');
    expectCode(() => a(st, 1, 'sideshow'), 'sideshow_locked');
  });

  it('19/20. only with the next active player on the left; compulsory; the weaker hand folds; cards stay private', async () => {
    const st = room(4);
    await toBetting(st, { 1: ['2s', '5h', '9d'], 2: ['As', 'Ah', 'Kd'], 3: ['Qs', 'Js', '3h'], 0: ['4c', '6c', '8d'] });
    for (const i of [0, 1, 2, 3]) a(st, i, 'see');
    a(st, 1, 'sideshow'); // seat 1 asks seat 2 (next on the left) and loses
    expect(st.players[1].status).toBe('packed');
    expect(st.players[2].status).toBe('in');
    const v = viewFor(st, uid(3));
    expect(v.players[1].cards).toBeNull();
    expect(v.players[2].cards).toBeNull();
    // seat 2 to act: the next active on its left is seat 3
    expect(viewFor(st, uid(2)).options.sideshow?.target).toBe(3);
  });

  it('skips folded players when finding the next player on the left', async () => {
    const st = room(4);
    await toBetting(st, { 3: ['As', 'Ah', 'Ad'] });
    for (const i of [0, 1, 2, 3]) a(st, i, 'see');
    a(st, 1, 'seen');
    a(st, 2, 'pack');
    expect(viewFor(st, uid(3)).options.sideshow?.target).toBe(0);
  });
});

describe('bonuses (tests 21, 22, 32)', () => {
  it('21. Three of a Kind pays N × (N−1) to the holder when they win the game; once only', async () => {
    const st = room(5);
    await toBetting(st, { 1: ['7s', '7h', '7d'] });
    for (const i of [2, 3, 4, 0]) { if (st.turn === 1) a(st, 1, 'blind'); a(st, st.turn, 'pack'); }
    expect(st.result!.winner).toBe(1);
    expect(st.result!.bonus).toEqual({ kind: 'trail', total: 20, each: 5 });
    expect(st.ledger.filter((t) => t.type === 'bonus_in' && t.game === st.game)).toHaveLength(1);
    expect(conserved(st, 5)).toBe(true);
  });

  it('21b. no bonus when the trail holder does not win', async () => {
    const st = room(3);
    await toBetting(st, { 1: ['7s', '7h', '7d'], 0: ['2c', '5d', '9h'], 2: ['3c', '8d', 'Jh'] });
    a(st, 1, 'pack'); a(st, 2, 'pack');
    expect(st.result!.bonus).toBeNull();
  });

  it('22. Four of a Kind in Well Cut game 1 pays the same bonus', async () => {
    const st = room(3);
    startGame(st, uid(0), now);
    await shuffleIn(st, rig(st, { 2: ['9s', '9h', '9d', '9c'] }, 4));
    cutWell(st);
    deal(st, uid(0), now);
    a(st, 1, 'pack'); a(st, 2, 'blind'); a(st, 0, 'pack');
    expect(st.result!.bonus).toEqual({ kind: 'quad', total: 6, each: 3 });
  });

  it('Three of a Kind also pays in Well Cut game 2 (the 3-card game) when the holder wins', async () => {
    const st = room(3);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    cutWell(st); deal(st, uid(0), now);
    a(st, 1, 'pack'); a(st, 2, 'pack'); // seat 0 wins game 1 and deals game 2
    next(st);
    expect(st.cardsEach).toBe(3);
    await shuffleIn(st, rig(st, { 2: ['Ks', 'Kh', 'Kd'] }, 3));
    deal(st, uid(0), now);
    a(st, 1, 'pack'); a(st, 2, 'blind'); a(st, 0, 'pack');
    expect(st.result!.winner).toBe(2);
    expect(st.result!.bonus).toEqual({ kind: 'trail', total: 6, each: 3 });
  });

  it('no bonus in the 2-card and 1-card games', async () => {
    const st = room(2);
    startGame(st, uid(0), now);
    await shuffleIn(st);
    cutWell(st); deal(st, uid(0), now); a(st, st.turn, 'pack');
    for (let g = 2; g <= 4; g++) {
      next(st); await shuffleIn(st); deal(st, st.dealerUid, now); a(st, st.turn, 'pack');
      if (st.cardsEach < 3) expect(st.result!.bonus).toBeNull(); // game 2 has 3 cards: a trail there does pay
    }
  });
});

describe('bank, loans and elimination (tests 24, 25)', () => {
  it('24. loans are up to 100 coins in total and recorded as a liability', async () => {
    const st = room(2);
    takeLoan(st, uid(1), 60, now);
    expectCode(() => takeLoan(st, uid(1), 41, now), 'loan_limit');
    takeLoan(st, uid(1), 40, now);
    expect(st.players[1].coins).toBe(200);
    expect(st.players[1].loan).toBe(100);
    expect(viewFor(st, uid(1)).options.loan).toBeNull();
  });

  it('asks for a loan when a player cannot afford the action', async () => {
    const st = room(2);
    await toBetting(st);
    st.players[1].coins = 0; st.players[0].coins += 100; // move coins, keep the total
    expectCode(() => a(st, 1, 'blind'), 'need_loan');
    expect(viewFor(st, uid(1)).options.loan).toEqual({ left: 100, needed: 1 });
    takeLoan(st, uid(1), 1, now);
    a(st, 1, 'blind');
  });

  it('a player who has used all 200 coins can ask another player for any amount; the lender accepts', async () => {
    const st = room(3);
    await toBetting(st);
    broke(st, 1, 0);
    expectCode(() => a(st, 1, 'blind'), 'need_player_loan');
    expect(viewFor(st, uid(1)).options.borrow).toBe(true);
    expect(viewFor(st, uid(2)).options.borrow).toBe(false);
    expectCode(() => requestPlayerLoan(st, uid(2), 0, 10, now), 'not_eligible');
    expectCode(() => requestPlayerLoan(st, uid(1), 2, 101, now), 'lender_short'); // Ravi has only 100
    requestPlayerLoan(st, uid(1), 2, 40, now);
    expect(viewFor(st, uid(2)).incoming).toEqual([{ id: 1, from: 1, amount: 40 }]);
    expectCode(() => answerPlayerLoan(st, uid(0), 1, true, now), 'not_lender');
    answerPlayerLoan(st, uid(2), 1, true, now);
    expect(st.players[1].coins).toBe(40);
    expect(st.players[2].coins).toBe(60);
    expect(viewFor(st, uid(0)).p2p).toMatchObject([{ borrowerName: 'Srinu', lenderName: 'Ravi', amount: 40 }]);
    expect(st.ledger.slice(-2).map((t) => [t.type, t.amount])).toEqual([['p2p_out', -40], ['p2p_in', 40]]);
    expect(conserved(st, 3)).toBe(true); // existing coins moved; none created
    a(st, 1, 'blind');
  });

  it('after a decline the borrower can ask someone else; a request can be cancelled', async () => {
    const st = room(4);
    await toBetting(st);
    broke(st, 1, 0);
    requestPlayerLoan(st, uid(1), 2, 30, now);
    expectCode(() => requestPlayerLoan(st, uid(1), 3, 30, now), 'request_open');
    const ev = answerPlayerLoan(st, uid(2), 1, false, now);
    expect(ev[0]).toMatchObject({ e: 'p2p_answer', accepted: false });
    expect(st.players[1].coins).toBe(0);
    requestPlayerLoan(st, uid(1), 3, 30, now);
    cancelPlayerLoan(st, uid(1));
    expect(st.requests).toEqual([]);
    requestPlayerLoan(st, uid(1), 0, 50, now);
    answerPlayerLoan(st, uid(0), 3, true, now);
    expect(st.players[1].coins).toBe(50);
  });

  it('player loans carry forward, count in the net, and add up per lender', async () => {
    const st = room(3);
    await toBetting(st);
    broke(st, 2, 0);
    requestPlayerLoan(st, uid(2), 0, 20, now); answerPlayerLoan(st, uid(0), 1, true, now);
    st.players[2].coins = 0; st.players[0].coins += 20; // spent it
    requestPlayerLoan(st, uid(2), 0, 15, now); answerPlayerLoan(st, uid(0), 2, true, now);
    expect(st.p2p).toHaveLength(1);
    expect(st.p2p[0].amount).toBe(35);
    expect(st.p2pLog).toEqual([
      { borrower: 'Ravi', lender: 'Rc', amount: 20, game: 1, at: now },
      { borrower: 'Ravi', lender: 'Rc', amount: 15, game: 1, at: now },
    ]);
    a(st, 1, 'pack'); a(st, 2, 'pack');
    toPlacecut(st);
    const rows = viewFor(st, uid(0)).scorecard!.rows;
    const ravi = rows.find((r) => r.name === 'Ravi')!, rc = rows.find((r) => r.name === 'Rc')!;
    expect(ravi.owesPlayers).toBe(35);
    expect(ravi.net).toBe(ravi.balance - 100 - 100 - 35);
    expect(rc.owedByPlayers).toBe(35);
    expect(rc.net).toBe(rc.balance - 100 - rc.outstandingLoan + 35);
    startGame(st, uid(0), now);
    expect(st.p2p[0].amount).toBe(35);
  });

  it('a player with no coins and no bank loan left sits a game out but stays at the table', async () => {
    const st = room(3);
    await toBetting(st);
    a(st, 1, 'pack'); a(st, 2, 'pack');
    broke(st, 2, 0);
    next(st);
    expect(st.players[2].status).toBe('eliminated');
    expect(st.dealt).not.toContain(2);
    expect(st.players).toHaveLength(3);
    // borrows during the game, plays the next one
    requestPlayerLoan(st, uid(2), 1, 25, now); answerPlayerLoan(st, uid(1), 1, true, now);
    await shuffleIn(st); cutMiss(st); deal(st, st.dealerUid, now);
    a(st, st.turn, 'pack');
    next(st);
    expect(st.players[2].status).toBe('in');
  });
});

describe('rounds, Placecut and settlement (tests 26, 28, 29)', () => {
  it('26. games follow each other for 20 minutes (each with its own settlement); then the current game finishes and Placecut opens', async () => {
    const st = room(3);
    startGame(st, uid(0), now);
    expect(st.roundEndsAt).toBe(now + 20 * 60_000);
    await shuffleIn(st); cutMiss(st); deal(st, uid(0), now);
    a(st, 1, 'pack'); a(st, 2, 'pack');
    // an individual game settlement, not a Placecut
    expect(st.phase).toBe('game_over');
    expect(viewFor(st, uid(1)).scorecard).toMatchObject({ kind: 'game', round: 1 });
    expect(viewFor(st, uid(1)).options.startGame).toBe(false);
    expectCode(() => startGame(st, uid(1), now), 'not_admin');
    expect(onDeadline(st, now + 10_000)).toEqual([]); // the admin starts the next game
    next(st);
    expect(st.game).toBe(2);
    await shuffleIn(st); cutMiss(st); deal(st, st.dealerUid, now);
    now += 21 * 60_000; // time runs out during game 2
    a(st, st.turn, 'blind'); // the game is not interrupted
    while (st.phase === 'betting') a(st, st.turn, 'pack');
    expect(viewFor(st, uid(0)).options.placecutDue).toBe(true);
    onDeadline(st, now + st.rules.nextGameSeconds * 1000);
    expect(st.phase).toBe('placecut');
    expect(viewFor(st, uid(0)).scorecard!.kind).toBe('placecut');
    startGame(st, uid(0), now); // the admin starts the next 20 minutes
    expect(st.round).toBe(2);
    expect(st.roundEndsAt).toBe(now + 20 * 60_000);
  });

  it('if nobody starts the next game, the Placecut opens by itself when the 20 minutes run out', async () => {
    const st = room(3);
    await toBetting(st);
    a(st, 1, 'pack'); a(st, 2, 'pack');
    expect(st.deadline!.at).toBe(st.roundEndsAt);
    onDeadline(st, st.roundEndsAt! + 1);
    expect(st.phase).toBe('placecut');
  });

  it('28/29. settlements show every figure; nothing resets at a game or a Placecut', async () => {
    const st = room(3);
    takeLoan(st, uid(2), 30, now);
    await toBetting(st);
    a(st, 1, 'blind'); a(st, 2, 'see'); a(st, 2, 'seen'); a(st, 0, 'pack'); a(st, 1, 'pack');
    let card = viewFor(st, uid(1)).scorecard!;
    expect(card).toMatchObject({ kind: 'game', round: 1 });
    const ravi = card.rows.find((r) => r.name === 'Ravi')!;
    expect(ravi).toMatchObject({ initial: 100, loanTotal: 30, outstandingLoan: 30, winnings: 3, startBalance: 130, change: 1 });
    expect(ravi.net).toBe(ravi.balance - 100 - 30);
    toPlacecut(st);
    startGame(st, uid(0), now);
    await shuffleIn(st); cutMiss(st); deal(st, st.dealerUid, now);
    while (st.phase === 'betting') a(st, st.turn, 'pack');
    card = viewFor(st, uid(1)).scorecard!;
    expect(card.round).toBe(2);
    expect(card.games).toBe(2);
    const ravi2 = card.rows.find((r) => r.name === 'Ravi')!;
    expect(ravi2.winnings).toBeGreaterThanOrEqual(3); // tournament totals carry forward
    expect(ravi2.games).toBe(2);
    expect(ravi2.outstandingLoan).toBe(30);
    expect(st.cardOutbox.map((c) => c.kind)).toEqual(['game', 'placecut', 'game']);
    expect(conserved(st, 3)).toBe(true);
  });

  it('only the admin can call off the tournament; the current game finishes first', async () => {
    const st = room(3);
    await toBetting(st);
    callOff(st, uid(0), now);
    expect(st.phase).toBe('betting');
    a(st, 1, 'pack'); a(st, 2, 'pack');
    nextGame(st, now);
    expect(st.phase).toBe('ended');
    expect(st.scorecards.at(-1)!.final).toBe(true);
  });
});

describe('timer switch and games with 2–7 players (tests 2, 32)', () => {
  it('the turn timer is off by default; when the admin switches it on, time-out packs', async () => {
    const st = room(3);
    await toBetting(st);
    expect(st.deadline).toBeNull();
    setTimer(st, uid(0), true, now);
    now += 31_000;
    const ev = onDeadline(st, now);
    expect(ev[0]).toMatchObject({ e: 'pack', seat: 1, reason: 'timeout' });
    expectCode(() => setTimer(st, uid(1), false, now), 'not_admin');
  });

  it('2. full random games with 2 to 10 players never create or lose coins', async () => {
    for (let n = 2; n <= 10; n++) {
      const st = room(n);
      startGame(st, uid(0), now);
      for (let g = 0; g < 25; g++) {
        await shuffleIn(st);
        if (st.phase === 'cutting') cut(st, cutter(st), st.cutBar!.startAt + Math.random() * 8000, now);
        deal(st, st.dealerUid, now);
        let guard = 400;
        while (st.phase === 'betting' && guard-- > 0) {
          const i = st.turn, v = viewFor(st, uid(i)), r = Math.random();
          const need = v.options.loan?.needed ?? 0;
          if (need > 0 && need <= v.options.loan!.left) takeLoan(st, uid(i), need, now);
          const p = st.players[i];
          if (v.options.borrow && p.coins < 2) {
            // borrow from the richest other player, who accepts half the time
            const rich = st.players.map((q, j) => [q.coins, j]).filter(([, j]) => j !== i).sort((x, y) => y[0] - x[0])[0];
            if (rich[0] >= 5) {
              const ev = requestPlayerLoan(st, uid(i), rich[1], 5, now);
              const id = (ev[0] as { id: number }).id;
              answerPlayerLoan(st, uid(rich[1]), id, Math.random() < 0.5, now);
            }
          }
          if (p.coins < (p.seen || v.options.mustSeen ? 2 : 1)) { a(st, i, 'pack'); continue; }
          if (v.options.see && r < 0.3) a(st, i, 'see');
          else if (v.options.show !== null && r < 0.6) a(st, i, 'show');
          else if (v.options.sideshow && r < 0.5) a(st, i, 'sideshow');
          else if (r < 0.15) a(st, i, 'pack');
          else a(st, i, v.options.blind ? 'blind' : 'seen');
        }
        expect(st.phase, `n=${n} game ${g}`).toBe('game_over');
        expect(conserved(st, n), `n=${n} game ${g}`).toBe(true);
        if (g % 7 === 6) now = st.roundEndsAt! + 1; // sometimes the 20 minutes run out
        startGame(st, uid(0), now); // next game, or the Placecut
        if (st.phase === 'placecut') {
          if (!viewFor(st, uid(0)).options.startGame) break;
          startGame(st, uid(0), now); // next 20 minutes
        }
      }
    }
  });
});
