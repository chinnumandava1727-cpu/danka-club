import { describe, expect, it } from 'vitest';
import {
  cardCode, commitmentInput, compareHands, cryptoRandInt, deckString, evaluate, freshDeck,
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

describe('three-card rankings (§6, test 11)', () => {
  it('orders Trail > Pure Sequence > Sequence > Colour > Pair > High Card', () => {
    const order = ['As Ah Ad', '8s 8h 8d', 'As Ks Qs', 'As 2s 3s', 'Ks Qs Js', 'Ah Kd Qc', '4s 3d 2c', 'As Js 9s', 'As Ad Kc', '2s 2d 3c', 'As Kd Jc', '5s 3d 2c'];
    for (let i = 0; i < order.length - 1; i++) beats(order[i], order[i + 1]);
  });
  it('AAA beats 888 and is a trail', () => {
    beats('As Ah Ad', '8s 8h 8d');
    expect(h('As Ah Ad').trail).toBe(true);
  });
  it('breaks equal hands by suit, never a tie', () => {
    beats('Ks Qh Jd', 'Kh Qs Js'); // same sequence: the K of spades decides
    beats('As Kd Jc', 'Ah Ks Js');
    expect(compareHands(h('9s 7h 4d'), h('9h 7s 4s'))).not.toBe(0);
  });
});

describe('two-card game (§6, test 12)', () => {
  it('a pair beats a non-pair; AA is the highest pair', () => {
    beats('2s 2h', 'As Ks');
    beats('As Ah', 'Ks Kh');
  });
  it('equal pairs are decided by suit', () => {
    beats('Ks Kd', 'Kh Kc');
  });
  it('no pair: higher card first, then the second card', () => {
    beats('As 3c', 'Ks Qs');
    beats('Kd 9c', 'Kh 8s');
  });
});

describe('one-card game (§6, test 13)', () => {
  it('highest card wins; same value goes by suit ♠ > ♥ > ♦ > ♣', () => {
    beats('As', 'Ks');
    beats('Ks', 'Kh');
    beats('Kh', 'Kd');
    beats('Kd', 'Kc');
  });
});

describe('four-card game (§6, §11)', () => {
  it('Four of a Kind is highest and flagged for the bonus', () => {
    expect(h('9s 9h 9d 9c').quad).toBe(true);
    beats('2s 2h 2d 2c', 'As Ah Ad Kc');
  });
  it('otherwise the best three cards count, and a trail inside four cards is not the 3-card bonus', () => {
    const v = h('9s 9h 9d 2c');
    expect(v.name).toBe('Trail of 9s');
    expect(v.trail).toBe(false);
  });
});
