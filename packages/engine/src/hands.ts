import { type Card, rankLabel } from './cards';

/**
 * DANKA hand comparison (rules section 6).
 * - 3 cards: Teen Patti order: Trail > Pure Sequence > Sequence > Colour > Pair > High Card.
 * - 4 cards (Well Cut game 1): Four of a Kind is highest; otherwise the best 3-card hand inside the 4.
 * - 2 cards: a pair beats a non-pair, AA highest; otherwise higher card, then second card.
 * - 1 card: highest card.
 * Equal values are always broken by the suit hierarchy ♠ > ♥ > ♦ > ♣, so two hands never tie.
 */

/** Suit strength: spades 3 (highest), hearts 2, diamonds 1, clubs 0 (lowest). */
export const suitStrength = (s: number): number => 3 - s;
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];

export const CAT = { HIGH: 1, PAIR: 2, COLOUR: 3, SEQUENCE: 4, PURE_SEQUENCE: 5, TRAIL: 6, FOUR_OF_A_KIND: 7 } as const;

export interface HandValue {
  /** Number of cards the hand was played with (1–4). */
  size: number;
  cat: number;
  /** Tie-break values, compared in order after the category: ranks first, then suit strengths. */
  key: number[];
  name: string;
  /** Three of a Kind in a 3-card game. */
  trail: boolean;
  /** Four of a Kind in the 4-card Well Cut game. */
  quad: boolean;
}

const plural = (r: number): string => ({ 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' } as Record<number, string>)[r] ?? `${r}s`;
const nameOf = (c: Card) => `${rankLabel(c.r)}${SUIT_SYMBOLS[c.s]}`;
/** Highest rank first; equal ranks ordered by suit strength. */
const sortCards = (cs: readonly Card[]) => [...cs].sort((a, b) => b.r - a.r || suitStrength(b.s) - suitStrength(a.s));

export function evalOne(c: Card): HandValue {
  return { size: 1, cat: CAT.HIGH, key: [c.r, suitStrength(c.s)], name: nameOf(c), trail: false, quad: false };
}

export function evalTwo(cs: readonly Card[]): HandValue {
  const [a, b] = sortCards(cs);
  if (a.r === b.r) {
    return { size: 2, cat: CAT.PAIR, key: [a.r, Math.max(suitStrength(a.s), suitStrength(b.s))], name: `Pair of ${plural(a.r)}`, trail: false, quad: false };
  }
  return { size: 2, cat: CAT.HIGH, key: [a.r, b.r, suitStrength(a.s), suitStrength(b.s)], name: `${rankLabel(a.r)}-${rankLabel(b.r)} high`, trail: false, quad: false };
}

export function evalThree(cs: readonly Card[]): HandValue {
  if (cs.length !== 3) throw new Error('evalThree needs exactly 3 cards');
  const s = sortCards(cs);
  const r = s.map((c) => c.r);
  const flush = cs.every((c) => c.s === cs[0].s);
  const base = { size: 3, trail: false, quad: false };
  if (r[0] === r[2]) return { ...base, cat: CAT.TRAIL, key: [r[0]], name: `Trail of ${plural(r[0])}`, trail: true };

  // Sequences: A-K-Q highest, then A-2-3, then K-Q-J down to 4-3-2 (traditional Teen Patti).
  let seqTop = 0;
  let seqOrder = s;
  if (r[0] - 1 === r[1] && r[1] - 1 === r[2]) seqTop = r[0] === 14 ? 15 : r[0];
  if (r[0] === 14 && r[1] === 3 && r[2] === 2) { seqTop = 14; seqOrder = [s[0], s[1], s[2]]; }
  const suitsOf = (list: Card[]) => list.map((c) => suitStrength(c.s));
  if (seqTop && flush) return { ...base, cat: CAT.PURE_SEQUENCE, key: [seqTop, ...suitsOf(seqOrder)], name: 'Pure Sequence' };
  if (seqTop) return { ...base, cat: CAT.SEQUENCE, key: [seqTop, ...suitsOf(seqOrder)], name: 'Sequence' };
  if (flush) return { ...base, cat: CAT.COLOUR, key: [...r, suitStrength(cs[0].s)], name: 'Colour' };
  if (r[0] === r[1] || r[1] === r[2]) {
    const p = r[0] === r[1] ? r[0] : r[1];
    const pairCards = s.filter((c) => c.r === p);
    const kicker = s.find((c) => c.r !== p)!;
    return { ...base, cat: CAT.PAIR, key: [p, kicker.r, Math.max(...pairCards.map((c) => suitStrength(c.s))), suitStrength(kicker.s)], name: `Pair of ${plural(p)}` };
  }
  return { ...base, cat: CAT.HIGH, key: [...r, ...suitsOf(s)], name: `${rankLabel(r[0])} High` };
}

const FOUR_COMBOS = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];

export function evalFour(cs: readonly Card[]): HandValue {
  if (cs.every((c) => c.r === cs[0].r)) {
    return { size: 4, cat: CAT.FOUR_OF_A_KIND, key: [cs[0].r], name: `Four ${plural(cs[0].r)}`, trail: false, quad: true };
  }
  let best: HandValue | null = null;
  for (const ix of FOUR_COMBOS) {
    const h = evalThree(ix.map((i) => cs[i]));
    if (!best || compareHands(h, best) > 0) best = h;
  }
  // A trail inside four cards is not the 3-card-game bonus.
  return { ...best!, size: 4, trail: false };
}

export function evaluate(cards: readonly Card[]): HandValue {
  switch (cards.length) {
    case 1: return evalOne(cards[0]);
    case 2: return evalTwo(cards);
    case 3: return evalThree(cards);
    case 4: return evalFour(cards);
    default: throw new Error(`Unsupported hand size ${cards.length}`);
  }
}

/** > 0 if `a` wins, < 0 if `b` wins. Never 0 for two different hands from one deck. */
export function compareHands(a: HandValue, b: HandValue): number {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const n = Math.max(a.key.length, b.key.length);
  for (let i = 0; i < n; i++) {
    const d = (a.key[i] ?? 0) - (b.key[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
