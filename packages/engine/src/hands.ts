import { type Card, rankLabel } from './cards';

/**
 * DANKA CLUB local card rules ("Local Card Rules – Developer Implementation Specification").
 *
 * Categories, highest first (sections 2–7):
 *   3 cards: Trail > Pure Sequence (Flush) > Sequence > Colour > Pair > High Card
 *   2 cards: Pair (22 highest, then AA, KK …) > Pure Sequence > Sequence > Colour > High Card
 *   4 cards: Four of a Kind is the highest hand; otherwise the best 3-card hand inside the 4 cards counts
 *            (confirmed by the group). Three matching cards inside four are ranked as a Trail but get no bonus.
 *   1 card:  highest card
 *
 * - Pure Sequence: consecutive values, all the same suit.
 * - Sequence: consecutive values and EVERY card a different suit (4♠ 5♠ 6♦ is not a Sequence).
 * - Colour: every card the same suit, not consecutive (two of three suited cards is not Colour).
 * - Aces in sequences (confirmed): A-K-Q highest, A-2-3 next, then K-Q-J down to 4-3-2.
 *
 * Tie-break (section 8): within a category the deciding values are compared first (pair value, then kicker,
 * or the cards highest first). When the values are the same, sort the cards highest value first and compare
 * suits card by card in that order: ♠ > ♥ > ♦ > ♣. Two hands from one deck never tie.
 */

/** Suit strength: spades 3 (highest), hearts 2, diamonds 1, clubs 0 (lowest). */
export const suitStrength = (s: number): number => 3 - s;
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];

export const CAT = {
  HIGH: 1,
  PAIR: 2,
  COLOUR: 3,
  SEQUENCE: 4,
  PURE_SEQUENCE: 5,
  TRAIL: 6,
  FOUR_OF_A_KIND: 7,
} as const;

export interface HandValue {
  /** Number of cards the hand was played with (1–4). */
  size: number;
  cat: number;
  /** Tie-break values, compared in order after the category: deciding values first, then suits highest card first. */
  key: number[];
  name: string;
  /** All three cards the same number in a 3-card game (Three of a Kind bonus). */
  trail: boolean;
  /** All four cards the same number in a 4-card game (Four of a Kind bonus). */
  quad: boolean;
}

const PLURAL: Record<number, string> = { 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const plural = (r: number): string => PLURAL[r] ?? `${r}s`;
const nameOf = (c: Card) => `${rankLabel(c.r)}${SUIT_SYMBOLS[c.s]}`;
/** §8 Highest value first; equal values ordered by suit (♠ first). */
export const sortCards = (cs: readonly Card[]) => [...cs].sort((a, b) => b.r - a.r || suitStrength(b.s) - suitStrength(a.s));
const suits = (s: readonly Card[]) => s.map((c) => suitStrength(c.s));

/**
 * Strength of a run of consecutive values, or 0 if the values are not consecutive.
 * A-high run (…Q-K-A) is the strongest (15); the A-low run (A-2-3…) comes next (14); then by top card.
 */
function runTop(valuesDesc: number[]): number {
  const n = valuesDesc.length;
  const consecutive = (v: number[]) => v.every((x, i) => i === 0 || v[i - 1] - 1 === x);
  if (new Set(valuesDesc).size !== n) return 0;
  if (consecutive(valuesDesc)) return valuesDesc[0] === 14 ? 15 : valuesDesc[0];
  if (valuesDesc[0] === 14) {
    const low = [...valuesDesc.slice(1), 1]; // ace played low: …3, 2, A
    if (consecutive(low)) return 14;
  }
  return 0;
}

const hand = (size: number, cat: number, key: number[], name: string, extra: Partial<HandValue> = {}): HandValue =>
  ({ size, cat, key, name, trail: false, quad: false, ...extra });

export function evalOne(c: Card): HandValue {
  return hand(1, CAT.HIGH, [c.r, suitStrength(c.s)], nameOf(c));
}

/** §5 Two-card game. */
export function evalTwo(cs: readonly Card[]): HandValue {
  const s = sortCards(cs), v = s.map((c) => c.r);
  if (v[0] === v[1]) {
    // Special local rule: 22 is the highest pair, then AA, KK, QQ …
    const p = v[0] === 2 ? 15 : v[0];
    return hand(2, CAT.TRAIL, [p, ...suits(s)], v[0] === 2 ? 'Pair of 2s (highest pair)' : `Pair of ${plural(v[0])}`);
  }
  return common(2, s);
}

/** §6 Three-card game. */
export function evalThree(cs: readonly Card[]): HandValue {
  if (cs.length !== 3) throw new Error('evalThree needs exactly 3 cards');
  const s = sortCards(cs), v = s.map((c) => c.r);
  if (v[0] === v[2]) return hand(3, CAT.TRAIL, [v[0], ...suits(s)], `Trail of ${plural(v[0])}`, { trail: true });
  const c = common(3, s);
  if (c.cat !== CAT.HIGH) return c;
  if (v[0] === v[1] || v[1] === v[2]) {
    const p = v[1];
    const kicker = v[0] === v[1] ? v[2] : v[0];
    return hand(3, CAT.PAIR, [p, kicker, ...suits(s)], `Pair of ${plural(p)}`);
  }
  return c;
}

/** §7 Four-card game (Well Cut game 1): Four of a Kind, otherwise the best three of the four cards. */
const FOUR_COMBOS = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
export function evalFour(cs: readonly Card[]): HandValue {
  if (cs.length !== 4) throw new Error('evalFour needs exactly 4 cards');
  const s = sortCards(cs), v = s.map((c) => c.r);
  if (v[0] === v[3]) return hand(4, CAT.FOUR_OF_A_KIND, [v[0], ...suits(s)], `Four ${plural(v[0])}`, { quad: true });
  let best: HandValue | null = null;
  for (const ix of FOUR_COMBOS) {
    const h3 = evalThree(ix.map((i) => s[i]));
    if (!best || compareHands(h3, best) > 0) best = h3;
  }
  // Three matching cards inside four rank as a Trail but never earn the bonus (§7).
  return { ...best!, size: 4, trail: false };
}

/** Pure Sequence, Sequence, Colour or High Card for 2–4 cards (sorted highest first). */
function common(size: number, s: Card[]): HandValue {
  const v = s.map((c) => c.r);
  const sameSuit = s.every((c) => c.s === s[0].s);
  const allDifferentSuits = new Set(s.map((c) => c.s)).size === s.length;
  const top = runTop(v);
  if (top && sameSuit) return hand(size, CAT.PURE_SEQUENCE, [top, ...suits(s)], 'Pure Sequence');
  if (top && allDifferentSuits) return hand(size, CAT.SEQUENCE, [top, ...suits(s)], 'Sequence');
  if (sameSuit) return hand(size, CAT.COLOUR, [...v, ...suits(s)], 'Colour');
  return hand(size, CAT.HIGH, [...v, ...suits(s)], `${rankLabel(v[0])} High`);
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
