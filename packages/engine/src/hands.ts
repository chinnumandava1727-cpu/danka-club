import { type Card, rankLabel } from './cards';

/** The game played in a single hand. */
export type HandMode = 'classic' | 'muflis' | 'ak47' | 'joker' | 'four';

export interface HandContext {
  mode: HandMode;
  /** Wild rank for Joker Draw (2..14). Ignored by other modes. */
  wild?: number;
}

export const CATEGORY = { HIGH: 1, PAIR: 2, COLOUR: 3, SEQUENCE: 4, PURE_SEQUENCE: 5, TRAIL: 6 } as const;

export interface HandValue {
  cat: number;
  /** Tie-break value inside the category. */
  tb: number;
  /** cat * 1e7 + tb. Higher is a stronger hand in normal play. */
  score: number;
  name: string;
  /** Number of wild cards used. */
  wilds: number;
}

const plural = (r: number): string => ({ 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' } as Record<number, string>)[r] ?? `${r}s`;

/**
 * Standard Teen Patti ranking for exactly three cards (stand-in until the
 * group confirms its own order, open question Q7):
 * Trail > Pure Sequence > Sequence > Colour > Pair > High Card.
 * Sequences: A-K-Q highest, then A-2-3, then K-Q-J down to 4-3-2.
 */
export function evalThree(cs: readonly Card[]): HandValue {
  if (cs.length !== 3) throw new Error('evalThree needs exactly 3 cards');
  const r = cs.map((c) => c.r).sort((a, b) => b - a);
  const flush = cs.every((c) => c.s === cs[0].s);
  const trail = r[0] === r[2];
  let seqTop = 0;
  if (r[0] - 1 === r[1] && r[1] - 1 === r[2]) seqTop = r[0] === 14 ? 15 : r[0];
  if (r[0] === 14 && r[1] === 3 && r[2] === 2) seqTop = 14;
  const pair = !trail && (r[0] === r[1] || r[1] === r[2]);
  let cat: number, tb: number, name: string;
  if (trail) { cat = CATEGORY.TRAIL; tb = r[0]; name = `Trail of ${plural(r[0])}`; }
  else if (seqTop && flush) { cat = CATEGORY.PURE_SEQUENCE; tb = seqTop; name = 'Pure Sequence'; }
  else if (seqTop) { cat = CATEGORY.SEQUENCE; tb = seqTop; name = 'Sequence'; }
  else if (flush) { cat = CATEGORY.COLOUR; tb = r[0] * 10000 + r[1] * 100 + r[2]; name = 'Colour'; }
  else if (pair) {
    const p = r[0] === r[1] ? r[0] : r[1];
    const k = r[0] === r[1] ? r[2] : r[0];
    cat = CATEGORY.PAIR; tb = p * 100 + k; name = `Pair of ${plural(p)}`;
  } else { cat = CATEGORY.HIGH; tb = r[0] * 10000 + r[1] * 100 + r[2]; name = `${rankLabel(r[0])} High`; }
  return { cat, tb, score: cat * 1e7 + tb, name, wilds: 0 };
}

export function isWild(c: Card, ctx: HandContext): boolean {
  if (ctx.mode === 'ak47') return c.r === 14 || c.r === 13 || c.r === 4 || c.r === 7;
  if (ctx.mode === 'joker') return ctx.wild !== undefined && c.r === ctx.wild;
  return false;
}

/** > 0 if `a` beats `b`, < 0 if `b` beats `a`, 0 if equal. Muflis reverses the order. */
export function compareHands(a: HandValue, b: HandValue, ctx: HandContext): number {
  return ctx.mode === 'muflis' ? b.score - a.score : a.score - b.score;
}

/** Best value of exactly three cards, letting each wild card become any card. */
export function evalWithWilds(cs: readonly Card[], ctx: HandContext): HandValue {
  const wilds = cs.filter((c) => isWild(c, ctx));
  if (!wilds.length) return evalThree(cs);
  const natural = cs.filter((c) => !isWild(c, ctx));
  // A wild only ever needs to match the naturals' suit (to make a flush) or differ from it.
  const same = (natural[0]?.s ?? 0) as Card['s'];
  const other = ((same + 1) % 4) as Card['s'];
  const options: Card[] = [];
  for (let r = 2; r <= 14; r++) options.push({ r, s: same }, { r, s: other });
  let best: HandValue | null = null;
  const pick = (k: number, acc: Card[]) => {
    if (k === wilds.length) {
      const h = evalThree([...natural, ...acc]);
      if (!best || compareHands(h, best, ctx) > 0) best = h;
      return;
    }
    for (const o of options) pick(k + 1, [...acc, o]);
  };
  pick(0, []);
  const b = best as unknown as HandValue;
  return { ...b, wilds: wilds.length, name: `${b.name} (${wilds.length > 1 ? 'jokers' : 'joker'})` };
}

const FOUR_COMBOS = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];

/** Best hand from 3 cards, or best 3 of 4 in Best of Four. */
export function bestHand(cards: readonly Card[], ctx: HandContext): HandValue {
  const combos = cards.length === 4 ? FOUR_COMBOS.map((ix) => ix.map((i) => cards[i])) : [cards];
  let best: HandValue | null = null;
  for (const cs of combos) {
    const h = evalWithWilds(cs, ctx);
    if (!best || compareHands(h, best, ctx) > 0) best = h;
  }
  return best!;
}
