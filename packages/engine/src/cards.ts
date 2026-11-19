/** Suits: 0 spades, 1 hearts, 2 diamonds, 3 clubs. */
export type Suit = 0 | 1 | 2 | 3;

/** A card. `r` is the rank, 2..14, where 11 = J, 12 = Q, 13 = K, 14 = A. */
export interface Card {
  r: number;
  s: Suit;
}

/** Returns a random integer in [0, maxExclusive). */
export type RandInt = (maxExclusive: number) => number;

const SUIT_CODES = ['s', 'h', 'd', 'c'] as const;
const RANK_CODES: Record<number, string> = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ r, s: s as Suit });
  return deck;
}

/**
 * Cryptographically secure random integer without modulo bias
 * (rejection sampling over a 32-bit draw).
 */
export function cryptoRandInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error('maxExclusive must be a positive integer');
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % maxExclusive;
}

/** Fisher–Yates shuffle. Returns a new array; the input is not changed. */
export function shuffle<T>(items: readonly T[], rand: RandInt = cryptoRandInt): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const rankLabel = (r: number): string => (r >= 11 ? { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r]! : String(r));

/** Two-character code, e.g. "As", "Td", "7c". */
export function cardCode(c: Card): string {
  return (RANK_CODES[c.r] ?? String(c.r)) + SUIT_CODES[c.s];
}

export function parseCard(code: string): Card {
  const rc = code.slice(0, -1);
  const sc = code.slice(-1);
  const s = SUIT_CODES.indexOf(sc as (typeof SUIT_CODES)[number]);
  const fromCode = Object.entries(RANK_CODES).find(([, v]) => v === rc);
  const r = fromCode ? Number(fromCode[0]) : Number(rc);
  if (s < 0 || !(r >= 2 && r <= 14)) throw new Error(`Bad card code: ${code}`);
  return { r, s: s as Suit };
}

export const deckString = (deck: readonly Card[]): string => deck.map(cardCode).join(' ');
export const parseDeck = (str: string): Card[] => str.split(' ').map(parseCard);

/** The exact text that is hashed for the fairness proof. */
export const commitmentInput = (deckStr: string, salt: string): string => `${deckStr}|${salt}`;

/** SHA-256 hex digest using Web Crypto (works in Workers, browsers and Node 18+). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Players can call this to check a finished hand: true if the revealed deck matches the fingerprint published before the deal. */
export async function verifyCommitment(commit: string, deckStr: string, salt: string): Promise<boolean> {
  return (await sha256Hex(commitmentInput(deckStr, salt))) === commit;
}
