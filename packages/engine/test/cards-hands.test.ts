import { describe, expect, it } from 'vitest';
import {
  bestHand, cardCode, commitmentInput, compareHands, cryptoRandInt, deckString, evalThree, freshDeck,
  parseCard, parseDeck, sha256Hex, shuffle, verifyCommitment, type HandContext,
} from '../src';

const h = (codes: string) => codes.split(' ').map(parseCard);
const classic: HandContext = { mode: 'classic' };

describe('cards', () => {
  it('builds 52 unique cards', () => {
    const d = freshDeck();
    expect(d).toHaveLength(52);
    expect(new Set(d.map(cardCode)).size).toBe(52);
  });

  it('shuffles into a permutation without changing the input', () => {
    const d = freshDeck();
    const s = shuffle(d);
    expect(d.map(cardCode)).toEqual(freshDeck().map(cardCode));
    expect([...s.map(cardCode)].sort()).toEqual([...d.map(cardCode)].sort());
  });

  it('crypto random ints stay in range and cover it', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = cryptoRandInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('round-trips deck strings', () => {
    const d = shuffle(freshDeck());
    expect(deckString(parseDeck(deckString(d)))).toBe(deckString(d));
  });

  it('verifies the fairness commitment and rejects a changed deck', async () => {
    const d = deckString(shuffle(freshDeck()));
    const commit = await sha256Hex(commitmentInput(d, 'salt123'));
    expect(await verifyCommitment(commit, d, 'salt123')).toBe(true);
    const tampered = d.split(' ').reverse().join(' ');
    expect(await verifyCommitment(commit, tampered, 'salt123')).toBe(false);
  });
});

describe('hand ranking (stand-in Teen Patti order)', () => {
  const order = [
    'As Ah Ad', // trail of aces
    '2s 2h 2d', // trail of 2s
    'As Ks Qs', // pure sequence, highest
    'As 2s 3s', // pure sequence, second
    'Ks Qs Js',
    'Ah Kd Qc', // sequence
    '4s 3d 2c',
    'As Js 9s', // colour
    'As Ad Kc', // pair of aces
    '2s 2d 3c', // pair of 2s
    'As Kd Jc', // high card
    '5s 3d 2c', // lowest possible
  ];
  it('orders categories and tie-breaks correctly', () => {
    const values = order.map((c) => evalThree(h(c)));
    for (let i = 0; i < values.length - 1; i++) {
      expect(compareHands(values[i], values[i + 1], classic), `${order[i]} > ${order[i + 1]}`).toBeGreaterThan(0);
    }
  });

  it('names hands', () => {
    expect(evalThree(h('7s 7h 7d')).name).toBe('Trail of 7s');
    expect(evalThree(h('Qs Qh 4d')).name).toBe('Pair of Queens');
    expect(evalThree(h('As 9d 4c')).name).toBe('A High');
  });

  it('Muflis reverses the order', () => {
    const muflis: HandContext = { mode: 'muflis' };
    const low = evalThree(h('5s 3d 2c'));
    const trail = evalThree(h('As Ah Ad'));
    expect(compareHands(low, trail, muflis)).toBeGreaterThan(0);
  });

  it('AK47 treats A, K, 4 and 7 as wild', () => {
    const ak: HandContext = { mode: 'ak47' };
    const v = bestHand(h('Ks 9h 9d'), ak);
    expect(v.name).toBe('Trail of 9s (joker)');
    expect(bestHand(h('As Kh 7d'), ak).name).toMatch(/^Trail of Aces/);
  });

  it('Joker Draw uses the drawn rank as wild', () => {
    const ctx: HandContext = { mode: 'joker', wild: 5 };
    expect(bestHand(h('5c Qs Js'), ctx).name).toBe('Pure Sequence (joker)');
    expect(bestHand(h('5c Qs Js'), classic).cat).toBe(1);
  });

  it('Best of Four plays the best three of four cards', () => {
    const v = bestHand(h('9s 9h 9d 2c'), { mode: 'four' });
    expect(v.name).toBe('Trail of 9s');
  });
});
