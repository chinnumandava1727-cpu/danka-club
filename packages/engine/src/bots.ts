/**
 * Computer players ("Play with computer"). The server seats them like anyone else and plays their turns with
 * these decisions, using exactly the same rules engine. They pause like people do, bet by the strength of
 * their cards, take bank loans, borrow from other players when they run out, and answer loan requests.
 */
import { type Card } from './cards';
import { CAT, evaluate } from './hands';
import {
  BOT_PREFIX, type GameEvent, type State, act, activeSeats, answerPlayerLoan, cancelPlayerLoan, cut, cutterSeat, deal, isBotUid,
  requestPlayerLoan, seatOf, takeLoan, viewFor,
} from './danka';

const NAMES = ['Chitti', 'Bujji', 'Pandu', 'Raju', 'Lucky', 'Sunny', 'Bablu', 'Gopi', 'Munna', 'Kittu'];

/** A fresh computer player's uid and name for this room. */
export function newBot(st: State): { uid: string; name: string } {
  const used = new Set([...st.players, ...st.departed.map((d) => ({ name: d.name }))].map((p) => p.name));
  const base = NAMES.find((n) => !used.has(`${n} (CPU)`)) ?? `Player ${st.players.length + 1}`;
  let k = 1;
  while (st.players.some((p) => p.uid === `${BOT_PREFIX}${k}`)) k++;
  return { uid: `${BOT_PREFIX}${k}`, name: `${base} (CPU)` };
}

/** 0 (worst) … 1 (best) for the cards a bot holds, in this game's size. */
export function handStrength(cards: Card[]): number {
  if (!cards.length) return 0;
  const h = evaluate(cards);
  const top = h.key[0] ?? 2;
  const size = cards.length;
  if (size === 1) return (cards[0].r - 2) / 12;
  if (h.cat === CAT.FOUR_OF_A_KIND) return 1;
  if (size === 2) {
    if (h.cat === CAT.TRAIL) return 0.82 + (top - 2) / 13 * 0.18; // any pair; 22 is top (15)
    if (h.cat === CAT.PURE_SEQUENCE) return 0.76;
    if (h.cat === CAT.SEQUENCE) return 0.66;
    if (h.cat === CAT.COLOUR) return 0.52;
    return Math.max(0, Math.min(0.42, (top - 6) / 8 * 0.42));
  }
  switch (h.cat) {
    case CAT.TRAIL: return 1;
    case CAT.PURE_SEQUENCE: return 0.95;
    case CAT.SEQUENCE: return 0.88;
    case CAT.COLOUR: return 0.76 + (top - 7) / 7 * 0.06;
    case CAT.PAIR: return 0.48 + (top - 2) / 12 * 0.2;
    default: return Math.max(0, Math.min(0.36, (top - 6) / 8 * 0.36));
  }
}

export interface BotTask { uid: string; at: number }

/** Time for the deal to land on everyone's screen before the first bet. */
const dealPause = (st: State) => (st.pot === 0 ? st.cardsEach * st.dealt.length * 150 + st.cardsEach * 700 : 0);

/** The next computer move to make, if any, and when (people take a moment, so do the bots). */
export function nextBotTask(st: State, now: number, rand = Math.random): BotTask | null {
  for (const r of st.requests) if (isBotUid(r.to)) return { uid: r.to, at: Math.max(now, r.at + 1100 + rand() * 1200) };
  if (st.phase === 'cutting') {
    const c = st.players[cutterSeat(st)];
    if (c && isBotUid(c.uid)) return { uid: c.uid, at: Math.max(now, (st.cutBar?.startAt ?? now) + 700 + rand() * 2800) };
  }
  if (st.phase === 'dealing' && isBotUid(st.dealerUid)) return { uid: st.dealerUid, at: now + 900 + rand() * 700 };
  if (st.phase === 'betting' && st.turn >= 0) {
    const p = st.players[st.turn];
    if (p && isBotUid(p.uid)) return { uid: p.uid, at: now + dealPause(st) + 650 + rand() * 1150 };
  }
  return null;
}

/** Make that move now. Returns no events if there is nothing for this bot to do any more. */
export function runBot(st: State, uid: string, now: number, rand = Math.random): GameEvent[] {
  const i = seatOf(st, uid);
  if (i < 0) return [];
  const p = st.players[i];
  // a loan request for this bot: lend when it can spare the coins
  const req = st.requests.find((r) => r.to === uid);
  if (req) return answerPlayerLoan(st, uid, req.id, p.coins >= req.amount + 10 && rand() < 0.75, now);
  if (st.phase === 'cutting' && cutterSeat(st) === i) return cut(st, uid, now, now);
  if (st.phase === 'dealing' && st.dealerUid === uid) return deal(st, uid, now);
  if (st.phase !== 'betting' || st.turn !== i) return [];

  const v = viewFor(st, uid), o = v.options;
  const cost = p.seen || o.mustSeen ? st.rules.seenCost : st.rules.blindCost;
  if (p.coins < cost) {
    if (o.loan && o.loan.left > 0) return takeLoan(st, uid, Math.min(o.loan.left, Math.max(cost - p.coins, 20)), now);
    const mine = st.requests.find((r) => r.from === uid);
    if (mine) {
      if (now - mine.at < 9000) return []; // still waiting for an answer
      // nobody answered: withdraw the request and pack this game
      return [...cancelPlayerLoan(st, uid), ...act(st, uid, { type: 'pack' }, now)];
    }
    if (o.borrow && !mine) {
      // ask the richest computer player first, then the richest person; never someone who said no this game
      const others = st.players.map((q, j) => ({ q, j }))
        .filter(({ q, j }) => j !== i && q.coins >= 15 && !st.declines.includes(`${uid}>${q.uid}`));
      others.sort((a, b) => Number(isBotUid(b.q.uid)) - Number(isBotUid(a.q.uid)) || b.q.coins - a.q.coins);
      if (others.length) {
        const lender = others[0];
        const amount = Math.max(1, Math.min(lender.q.coins - 10, 10 + Math.floor(rand() * 25)));
        return requestPlayerLoan(st, uid, lender.j, amount, now);
      }
    }
    return act(st, uid, { type: 'pack' }, now);
  }

  const active = activeSeats(st).length;
  if (!p.seen) {
    if (o.mustSeen) return act(st, uid, { type: 'seen' }, now);
    // stay Blind for a while, then look; more likely as the pot grows
    const myBets = Math.round(p.contributed / st.rules.blindCost);
    if (rand() < 0.16 + 0.07 * myBets + st.pot / 400) return act(st, uid, { type: 'see' }, now);
    if (o.show !== null && active === 2 && rand() < 0.08) return act(st, uid, { type: 'show' }, now);
    return act(st, uid, { type: 'blind' }, now);
  }

  const s = handStrength(p.cards);
  if (o.show !== null && active === 2) {
    if (s > 0.62 || (s > 0.4 && rand() < 0.3) || (p.contributed > 30 && rand() < 0.45)) return act(st, uid, { type: 'show' }, now);
  }
  if (o.sideshow && s > 0.3 && s < 0.72 && rand() < 0.3) return act(st, uid, { type: 'sideshow' }, now);
  const pressure = 1 + st.pot / 60;
  const packChance = (s < 0.18 ? 0.5 : s < 0.32 ? 0.26 : s < 0.5 ? 0.1 : s < 0.7 ? 0.03 : 0) * pressure;
  if (rand() < packChance) return act(st, uid, { type: 'pack' }, now);
  return act(st, uid, { type: 'seen' }, now);
}
