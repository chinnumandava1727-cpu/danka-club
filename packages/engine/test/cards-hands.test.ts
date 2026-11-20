import { describe, expect, it } from 'vitest';
import {
  CAT, cardCode, commitmentInput, compareHands, cryptoRandInt, deckString, evaluate, freshDeck,
  parseCard, parseDeck, sha256Hex, shuffle, verifyCommitment,
} from '../src';

const h = (codes: string) => evaluate(codes.split(' ').map(parseCard));
const beats = (a: string, b: string) => expect(compareHands(h(a), h(b)), `${a} should beat ${b}`).toBeGreaterThan(0);

describe('cards and secure shuffle (§4, test 5)', () => {
  it('builds 52 unique cards', () => {
    const d = freshDeck();
    expect(d).toHaveLength(52);
    expect(new Set(d.map(cardCode)).size).toBe(52);
  });

  it('shuffles into a permutation without changing the input', () => {
    const d = freshDeck();
    const s = shuffle(d);
    expect([...s.map(cardCode)].sort()).toEqual([...d.map(cardCode)].sort());
  });

  it('crypto random ints are unbiased in range (rejection sampling)', () => {
    const counts = new Array(7).fill(0);
    for (let i = 0; i < 14000; i++) counts[cryptoRandInt(7)]++;
    for (const c of counts) expect(c).toBeGreaterThan(1700); // expected 2000 each
  });

  it('round-trips deck strings and verifies the fairness fingerprint', async () => {
    const d = deckString(shuffle(freshDeck()));
    expect(deckString(parseDeck(d))).toBe(d);
    const commit = await sha256Hex(commitmentInput(d, 'salt'));
    expect(await verifyCommitment(commit, d, 'salt')).toBe(true);
    expect(await verifyCommitment(commit, d.split(' ').reverse().join(' '), 'salt')).toBe(false);
  });
});


describe('local rules §2–4: Pure Sequence, Sequence, Colour', () => {
  it('Pure Sequence = consecutive and all one suit', () => {
    expect(h('4s 5s 6s').name).toBe('Pure Sequence');
    expect(h('7d 8d 9d').name).toBe('Pure Sequence');
  });
  it('an ordinary Sequence needs every card in a different suit', () => {
    expect(h('4s 5h 6d').name).toBe('Sequence');
    expect(h('7d 8c 9h').name).toBe('Sequence');
    expect(h('4s 5s 6d').cat).toBe(CAT.HIGH); // two spades: not a Sequence, not a Colour
  });
  it('Colour = every card the same suit, not consecutive; two suited cards of three is not Colour', () => {
    expect(h('Kd 2d 8d').name).toBe('Colour');
    expect(h('4s 7s Ks').name).toBe('Colour');
    expect(h('4d 7d Ks').cat).toBe(CAT.HIGH);
  });
});

describe('three-card game §6 (test 11)', () => {
  it('orders Trail > Pure Sequence > Sequence > Colour > Pair > High Card', () => {
    const order = ['8s 8h 8d', '4s 5s 6s', '4s 5h 6d', 'Kd 7d 2d', 'Qs Qh 3c', 'As Jd 4h'];
    for (let i = 0; i < order.length - 1; i++) beats(order[i], order[i + 1]);
  });
  it('AAA is the highest Three of a Kind, above 888, and both are trails for the bonus', () => {
    beats('As Ah Ad', '8s 8h 8d');
    expect(h('As Ah Ad').trail && h('8s 8h 8d').trail).toBe(true);
  });
  it('4♠ 5♠ 6♦ (not a Sequence) loses to a real Sequence and to a Colour', () => {
    beats('2s 3h 4d', '4s 5s 6d');
    beats('Kd 7d 2d', '4s 5s 6d');
  });
  it('Aces in sequences: A-K-Q highest, then A-2-3, then K-Q-J', () => {
    beats('As Kh Qd', 'As 2h 3d');
    beats('Ac 2h 3d', 'Ks Qh Jd');
  });
});

describe('two-card game §5 (test 12)', () => {
  it('any two cards of the same number are a Pair, the top category; 22 beats AA, AA beats KK', () => {
    beats('2c 2d', 'As Ah');
    beats('As Ah', 'Ks Kh');
    beats('3c 3d', 'As Ks'); // even a pure sequence
  });
  it('categories: Pair > Pure Sequence > Sequence > Colour > High Card', () => {
    expect(h('Kd 2d').name).toBe('Colour');
    expect(h('4s 5s').name).toBe('Pure Sequence');
    expect(h('4s 5h').name).toBe('Sequence');
    expect(h('Ah 5c').cat).toBe(CAT.HIGH);
    beats('4s 5s', '4h 5d');
    beats('4h 5d', 'Kd 2d');
    beats('Kd 2d', 'Ah 5c'); // the document's example: Colour beats High Card
  });
  it('no Three or Four of a Kind bonus in the two-card game', () => {
    expect(h('2c 2d').trail || h('2c 2d').quad).toBe(false);
  });
});

describe('suit tie-break §8: sort highest first, compare value then suit, then the next card', () => {
  it("the document's example: A♠ 2♦ beats A♦ 2♣", () => beats('As 2d', 'Ad 2c'));
  it('equal pairs go to the highest card’s suit', () => {
    beats('Ks Kd', 'Kh Kc');
    beats('Ks Kc 3c', 'Kh Kd 3s');
  });
  it('same values: the highest card decides first, even if a lower card has the better suit', () => {
    beats('Ks Qc 9c', 'Kh Qs 9s'); // high card K-Q-9 both: K♠ beats K♥
    beats('9s 5s 2s', '9h 5h 2h'); // Colour
    beats('5h 6d 7s', '5s 6h 7d'); // Sequence: the highest cards are 7♠ and 7♦, so 7♠ wins
  });
  it('different values in the same category: the higher values win before suits', () => {
    beats('Ac Kc 9d', 'As Qs 9h');
    beats('Qc Qd 9c', 'Js Jh As');
  });
  it('every pair of distinct hands is decided (no ties) in 1-, 2-, 3- and 4-card games', () => {
    const deck = freshDeck();
    for (const size of [1, 2, 3, 4]) {
      for (let k = 0; k < 4000; k++) {
        const d = shuffle(deck);
        const a = evaluate(d.slice(0, size)), b = evaluate(d.slice(size, size * 2));
        expect(compareHands(a, b)).not.toBe(0);
        expect(Math.sign(compareHands(a, b))).toBe(-Math.sign(compareHands(b, a)));
      }
    }
  });
});

describe('one-card game (test 13)', () => {
  it('highest card wins; same value goes by suit ♠ > ♥ > ♦ > ♣', () => {
    beats('As', 'Ks');
    beats('Qs', 'Qh'); beats('Qh', 'Qd'); beats('Qd', 'Qc');
  });
});

describe('four-card game §7 (Well Cut game 1)', () => {
  it('Four of a Kind is the highest hand and flagged for the bonus; AAAA beats 2222', () => {
    expect(h('As Ah Ad Ac').quad && h('2s 2h 2d 2c').quad).toBe(true);
    beats('As Ah Ad Ac', '2s 2h 2d 2c');
    beats('2s 2h 2d 2c', 'Js Qs Ks As');
  });
  it('2AAA and AAAK are not Four of a Kind: no bonus', () => {
    expect(h('2s Ah Ad Ac').quad).toBe(false);
    expect(h('As Ah Ad Kc').quad).toBe(false);
    expect(h('As Ah Ad Kc').trail).toBe(false);
  });
  it('same principles adapted to four cards (awaiting confirmation)', () => {
    expect(h('4s 5s 6s 7s').name).toBe('Pure Sequence');
    expect(h('4s 5h 6d 7c').name).toBe('Sequence');
    expect(h('4s 5s 6d 7c').cat).toBe(CAT.HIGH);
    expect(h('2s 5s 9s Ks').name).toBe('Colour');
    const order = ['9s 9h 9d 9c', '4s 5s 6s 7s', '4s 5h 6d 7c', '2s 5s 9s Ks', 'Qs Qh Qd 3c', 'Js Jh 4d 4c', 'Ts Th 8d 3c', 'As Kh 9d 4c'];
    for (let i = 0; i < order.length - 1; i++) beats(order[i], order[i + 1]);
  });
});
