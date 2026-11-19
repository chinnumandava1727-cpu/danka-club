import { parseCard } from '@danka/engine';

// §12 Suit order, strongest first: Spades, Hearts, Diamonds, Clubs.
const SUITS = ['♠', '♥', '♦', '♣'];
const SCLASS = ['s-sp', 's-ht', 's-di', 's-cl'];
const RL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function CardFace({ code }: { code: string }) {
  const c = parseCard(code);
  const s = SUITS[c.s] + '︎';
  return (
    <div className={`cf ${SCLASS[c.s]}`}>
      <span className="cr">{RL[c.r] ?? c.r}</span>
      <span className="cs">{s}</span>
      <span className="cbig">{s}</span>
    </div>
  );
}

/** "21 cards ÷ 7 players" style helper. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
