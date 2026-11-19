import { isWild, parseCard, type HandMode } from '@danka/engine';

const SUITS = ['♠', '♥', '♦', '♣'];
const SCLASS = ['s-sp', 's-ht', 's-di', 's-cl'];
const RL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function CardFace({ code, mode, wild }: { code: string; mode: HandMode; wild: number }) {
  const c = parseCard(code);
  const jk = isWild(c, { mode, wild: wild || undefined });
  const s = SUITS[c.s] + '︎';
  return (
    <div className={`cf ${SCLASS[c.s]}${jk ? ' jk' : ''}`}>
      <span className="cr">{RL[c.r] ?? c.r}</span>
      <span className="cs">{s}</span>
      <span className="cbig">{s}</span>
    </div>
  );
}

export const plural = (r: number) => ({ 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' } as Record<number, string>)[r] ?? `${r}s`;
