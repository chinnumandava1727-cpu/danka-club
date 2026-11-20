/**
 * DANKA CLUB game engine: the group's own rules, nothing else.
 *
 * Pure logic, no I/O. The room server owns one State per room, passes in the time,
 * shuffled decks and the dealer's cut, and broadcasts the events returned.
 * Functions mutate the state they are given; invalid moves throw GameError and
 * leave the state unchanged.
 *
 * Rule references (§) are to "DANKA CLUB – Complete Game Rules, Regulations & Developer Specification".
 */
import { type Card, cardCode, cryptoRandInt, deckString } from './cards';
import { type HandValue, compareHands, evaluate } from './hands';
import { type DankaRules, MAX_SEATS } from './rules';

export type Phase =
  | 'lobby' // waiting for players before the first round
  | 'shuffling' // the server is shuffling a fresh deck
  | 'cutting' // the dealer picks a bunch of cards (Well Cut check)
  | 'dealing' // cards are locked; the dealer distributes them
  | 'betting'
  | 'game_over'
  | 'placecut' // 20-minute round over: scorecard, leave/join, admin starts the next round
  | 'ended'; // session called off

export type PlayerStatus = 'in' | 'packed' | 'eliminated';

export interface RoundStats {
  received: number; // pot winnings + bonuses received
  paid: number; // Blind/Seen/Show/Sideshow payments + bonuses paid
  winnings: number; // pots won
  losses: number; // coins put into games that were lost
  bonusIn: number;
  bonusOut: number;
  loans: number;
  games: number;
}

export interface Player {
  uid: string;
  name: string;
  coins: number;
  /** Total borrowed from the central bank (a liability; §13). */
  loan: number;
  status: PlayerStatus;
  seen: boolean;
  cards: Card[];
  connected: boolean;
  /** §9 Blind actions made while every other active player was Seen. */
  extraBlinds: number;
  /** Coins put into the current pot. */
  contributed: number;
  joinedRound: number;
  roundStartCoins: number;
  rs: RoundStats;
}

export type TxType =
  | 'initial' | 'blind' | 'seen' | 'show' | 'sideshow' | 'pot_win' | 'bonus_in' | 'bonus_out'
  | 'loan' | 'eliminated' | 'placecut' | 'leave' | 'admin';

/** §17 One ledger entry. `amount` is + for coins in, − for coins out. */
export interface Tx {
  id: number;
  at: number;
  round: number;
  game: number;
  uid: string;
  name: string;
  type: TxType;
  amount: number;
  balance: number;
  note?: string;
}

export interface ShowInfo {
  a: number;
  b: number;
  aCards: string[];
  bCards: string[];
  aHand: HandValue;
  bHand: HandValue;
}

export interface GameResult {
  round: number;
  game: number;
  winner: number;
  winnerName: string;
  pot: number;
  reason: 'all_packed' | 'show';
  show: ShowInfo | null;
  /** Three/Four of a Kind bonus paid to the winner (§11). */
  bonus: { kind: 'trail' | 'quad'; total: number; each: number } | null;
  cardsEach: number;
  /** 1–4 when this was a Well Cut game. */
  wellCutGame: number | null;
  /** Fairness proof, revealed after the game. */
  commit: string;
  deck: string;
  salt: string;
}

export interface GameRecord {
  round: number;
  game: number;
  winner: string;
  pot: number;
  bonus: number;
  cardsEach: number;
  wellCutGame: number | null;
  reason: 'all_packed' | 'show';
  at: number;
}

export interface ScoreRow {
  name: string;
  startBalance: number;
  received: number;
  paid: number;
  winnings: number;
  losses: number;
  balance: number;
  initial: number;
  loanTotal: number;
  outstandingLoan: number;
  bonusIn: number;
  bonusOut: number;
  /** Balance − initial allocation − outstanding loan. */
  net: number;
  eliminated: boolean;
  left: boolean;
  games: number;
}

/** §15 Placecut scorecard. */
export interface Scorecard {
  round: number;
  at: number;
  final: boolean;
  games: number;
  results: GameRecord[];
  totalPot: number;
  totalBonus: number;
  wellCuts: number;
  loansIssued: number;
  rows: ScoreRow[];
}

export interface CutInfo {
  /** Where the slider stopped: 0 = top of the bar, 0.5 = middle, 1 = bottom. */
  pos: number;
  /** Distance from the middle, in percent of the bar. */
  off: number;
  players: number;
  wellCut: boolean;
}

/** §5 The Well Cut timing bar: when the slider starts and how long each pass takes. */
export interface CutBar {
  startAt: number;
  durs: number[];
  zone: number;
}

export interface Deadline {
  kind: 'turn' | 'cut' | 'deal' | 'next_game';
  at: number;
}

export type GameEvent =
  | { e: 'joined'; seat: number; name: string; rejoined: boolean }
  | { e: 'left'; name: string }
  | { e: 'round'; round: number; endsAt: number }
  | { e: 'game'; game: number; cardsEach: number; wellCutGame: number | null }
  | { e: 'commit'; hash: string }
  | { e: 'cut'; seat: number; pos: number; off: number; players: number; wellCut: boolean; auto: boolean }
  | { e: 'deal'; dealer: number; order: number[]; cardsEach: number; auto: boolean }
  | { e: 'turn'; seat: number }
  | { e: 'see'; seat: number; auto: boolean }
  | { e: 'bet'; seat: number; kind: 'blind' | 'seen' | 'show' | 'sideshow'; amount: number }
  | { e: 'pack'; seat: number; reason: 'choice' | 'timeout' }
  | { e: 'sideshow'; from: number; to: number; loser: number }
  | { e: 'show'; a: number; b: number; winner: number }
  | { e: 'win'; seat: number; pot: number; reason: 'all_packed' | 'show' }
  | { e: 'bonus'; seat: number; kind: 'trail' | 'quad'; total: number; each: number }
  | { e: 'loan'; seat: number; amount: number }
  | { e: 'eliminated'; seat: number }
  | { e: 'placecut'; round: number }
  | { e: 'ended' }
  | { e: 'timer'; on: boolean }
  | { e: 'call_off' }
  | { e: 'table_size'; size: number };

export interface State {
  v: 2;
  rules: DankaRules;
  createdAt: number;
  adminUid: string;
  tableSize: number;
  players: Player[];
  departed: ScoreRow[];
  phase: Phase;
  round: number;
  roundEndsAt: number | null;
  callOff: boolean;
  timerOn: boolean;
  game: number;
  roundGames: number;
  dealerUid: string;
  turn: number;
  pot: number;
  cardsEach: number;
  /** Players dealt into the current game (for the bonus count N). */
  dealt: number[];
  wellCut: { active: boolean; index: number };
  wellCutCount: number;
  wellCutsThisRound: number;
  loansThisRound: number;
  lastCut: CutInfo | null;
  cutBar: CutBar | null;
  commit: string | null;
  /** Server-only: the current deck and salt. Never sent to phones before the game ends. */
  secret: { deck: string; salt: string; cards: Card[] } | null;
  result: GameResult | null;
  deadline: Deadline | null;
  history: GameRecord[];
  scorecards: Scorecard[];
  ledger: Tx[];
  /** New ledger entries since the server last saved them. */
  outbox: Tx[];
  txSeq: number;
}

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const fail = (code: string, message: string): never => {
  throw new GameError(code, message);
};
const LEDGER_TAIL = 300;
const emptyStats = (): RoundStats => ({ received: 0, paid: 0, winnings: 0, losses: 0, bonusIn: 0, bonusOut: 0, loans: 0, games: 0 });

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export const seatOf = (st: State, uid: string) => st.players.findIndex((p) => p.uid === uid);
const requireSeat = (st: State, uid: string) => {
  const i = seatOf(st, uid);
  if (i < 0) fail('not_seated', 'You are not in this room.');
  return i;
};
export const dealerIndex = (st: State) => Math.max(0, seatOf(st, st.dealerUid));
export const activeSeats = (st: State) => st.players.flatMap((p, i) => (p.status === 'in' ? [i] : []));
const inRound = (st: State) => ['shuffling', 'cutting', 'dealing', 'betting', 'game_over'].includes(st.phase);

export function nextActive(st: State, from: number): number {
  const n = st.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n;
    if (st.players[j].status === 'in') return j;
  }
  return -1;
}

export const costFor = (st: State, i: number) => (st.players[i].seen ? st.rules.seenCost : st.rules.blindCost);
export const loanLeft = (st: State, i: number) => Math.max(0, st.rules.maxLoan - st.players[i].loan);
/** §9 True when this Blind player is the only Blind one left among the active players. */
export const onlyBlindLeft = (st: State, i: number) =>
  !st.players[i].seen && st.players[i].status === 'in' && activeSeats(st).every((j) => j === i || st.players[j].seen);
const allActiveSeen = (st: State) => activeSeats(st).every((j) => st.players[j].seen);
const wellCutGameNo = (st: State) => (st.wellCut.active ? st.wellCut.index + 1 : null);

function tx(st: State, now: number, i: number | Player, type: TxType, amount: number, note?: string) {
  const p = typeof i === 'number' ? st.players[i] : i;
  const t: Tx = { id: ++st.txSeq, at: now, round: st.round, game: st.game, uid: p.uid, name: p.name, type, amount, balance: p.coins, note };
  st.ledger.push(t);
  st.outbox.push(t);
  if (st.ledger.length > LEDGER_TAIL) st.ledger.splice(0, st.ledger.length - LEDGER_TAIL);
}

function newPlayer(st: State, uid: string, name: string, now: number): Player {
  const p: Player = {
    uid, name: name.trim().slice(0, 24) || `Player ${st.players.length + 1}`,
    coins: st.rules.startingCoins, loan: 0, status: 'in', seen: false, cards: [], connected: true,
    extraBlinds: 0, contributed: 0, joinedRound: st.round, roundStartCoins: st.rules.startingCoins, rs: emptyStats(),
  };
  return p;
}

/* ------------------------------------------------------------------ */
/* room, players, admin                                                */
/* ------------------------------------------------------------------ */

export function createRoom(opts: { rules: DankaRules; admin: { uid: string; name: string }; now: number; tableSize?: number }): State {
  const r = opts.rules;
  const st: State = {
    v: 2, rules: { ...r, wellCutSequence: [...r.wellCutSequence] }, createdAt: opts.now, adminUid: opts.admin.uid,
    tableSize: Math.max(r.minPlayers, Math.min(r.maxPlayers, MAX_SEATS, Math.round(opts.tableSize ?? r.maxPlayers))),
    players: [], departed: [], phase: 'lobby', round: 0, roundEndsAt: null, callOff: false, timerOn: false,
    game: 0, roundGames: 0, dealerUid: opts.admin.uid, turn: -1, pot: 0, cardsEach: r.normalCards, dealt: [],
    wellCut: { active: false, index: 0 }, wellCutCount: 0, wellCutsThisRound: 0, loansThisRound: 0, lastCut: null, cutBar: null,
    commit: null, secret: null, result: null, deadline: null, history: [], scorecards: [], ledger: [], outbox: [], txSeq: 0,
  };
  join(st, opts.admin.uid, opts.admin.name, opts.now);
  return st;
}

/** §2 Join, or reconnect to your own seat. New players may only join before the first round or at Placecut. */
export function join(st: State, uid: string, name: string, now: number): { seat: number; events: GameEvent[] } {
  const existing = seatOf(st, uid);
  if (existing >= 0) {
    st.players[existing].connected = true;
    return { seat: existing, events: [{ e: 'joined', seat: existing, name: st.players[existing].name, rejoined: true }] };
  }
  if (st.phase === 'ended') fail('room_closed', 'This session has ended.');
  if (st.phase !== 'lobby' && st.phase !== 'placecut') fail('round_in_progress', 'A round is being played. You can join at the next Placecut.');
  if (st.players.length >= st.tableSize) fail('room_full', `This table is full (${st.tableSize}/${st.tableSize}).`);
  const p = newPlayer(st, uid, name, now);
  st.players.push(p);
  const seat = st.players.length - 1;
  tx(st, now, seat, 'initial', st.rules.startingCoins, seat === 0 ? 'Room created; deals the first game' : 'Joined');
  return { seat, events: [{ e: 'joined', seat, name: p.name, rejoined: false }] };
}

export function setConnected(st: State, uid: string, connected: boolean) {
  const i = seatOf(st, uid);
  if (i >= 0) st.players[i].connected = connected;
}

function rowFor(st: State, p: Player, left: boolean): ScoreRow {
  return {
    name: p.name, startBalance: p.roundStartCoins, received: p.rs.received, paid: p.rs.paid, winnings: p.rs.winnings, losses: p.rs.losses,
    balance: p.coins, initial: st.rules.startingCoins, loanTotal: p.loan, outstandingLoan: p.loan, bonusIn: p.rs.bonusIn, bonusOut: p.rs.bonusOut,
    net: p.coins - st.rules.startingCoins - p.loan, eliminated: p.status === 'eliminated', left, games: p.rs.games,
  };
}

/** §2/§15 Leave the room: only before the first round or at Placecut. History and loans stay recorded. */
export function leave(st: State, uid: string, now: number): GameEvent[] {
  const i = requireSeat(st, uid);
  if (uid === st.adminUid) fail('admin_cannot_leave', 'The admin ends the session instead of leaving.');
  if (st.phase !== 'lobby' && st.phase !== 'placecut' && st.phase !== 'ended') fail('round_in_progress', 'You can leave at Placecut, when the round ends.');
  const p = st.players[i];
  tx(st, now, i, 'leave', 0, `Left with ${p.coins} coins, loan ${p.loan}`);
  st.departed.push(rowFor(st, p, true));
  st.players.splice(i, 1);
  return [{ e: 'left', name: p.name }];
}

export function setTableSize(st: State, uid: string, size: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can change the table size.');
  if (st.phase !== 'lobby' && st.phase !== 'placecut') fail('round_in_progress', 'Change the table size at Placecut.');
  const n = Math.max(st.rules.minPlayers, Math.min(st.rules.maxPlayers, MAX_SEATS, Math.round(size)));
  if (n < st.players.length) fail('too_small', `${st.players.length} players are already seated.`);
  st.tableSize = n;
  return [{ e: 'table_size', size: n }];
}

/** Admin switch for the turn timer (off by default). */
export function setTimer(st: State, uid: string, on: boolean, now: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can switch the timer.');
  st.timerOn = on;
  tx(st, now, seatOf(st, uid), 'admin', 0, `Turn timer switched ${on ? 'on' : 'off'}`);
  if (st.deadline?.kind !== 'next_game') st.deadline = null;
  if (on) {
    if (st.phase === 'betting') st.deadline = { kind: 'turn', at: now + st.rules.turnSeconds * 1000 };
    if (st.phase === 'cutting') st.deadline = { kind: 'cut', at: Math.max(now, st.cutBar?.startAt ?? now) + st.rules.turnSeconds * 1000 };
    if (st.phase === 'dealing') st.deadline = { kind: 'deal', at: now + st.rules.turnSeconds * 1000 };
  }
  return [{ e: 'timer', on }];
}

/* ------------------------------------------------------------------ */
/* rounds and Placecut (§14)                                           */
/* ------------------------------------------------------------------ */

export function startRound(st: State, uid: string, now: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can start a round.');
  if (st.phase !== 'lobby' && st.phase !== 'placecut') fail('round_in_progress', 'A round is already running.');
  // §13 Players knocked out after losing 200 coins must leave after their settlement.
  // The admin cannot leave (they run the room), so an eliminated admin stays seated as host but no longer plays.
  for (let i = st.players.length - 1; i >= 0; i--) {
    const p = st.players[i];
    if (p.status === 'eliminated' && p.uid !== st.adminUid) {
      tx(st, now, i, 'leave', 0, 'Eliminated: left after settlement');
      st.departed.push(rowFor(st, p, true));
      st.players.splice(i, 1);
    }
  }
  const playing = st.players.filter((p) => p.status !== 'eliminated');
  if (playing.length < st.rules.minPlayers) fail('not_enough_players', `At least ${st.rules.minPlayers} players are needed.`);
  st.round += 1;
  st.roundEndsAt = now + st.rules.roundMinutes * 60_000;
  st.roundGames = 0;
  st.wellCutsThisRound = 0;
  st.loansThisRound = 0;
  st.history = [];
  st.callOff = false;
  for (const p of st.players) {
    p.roundStartCoins = p.coins;
    p.rs = emptyStats();
    if (p.status !== 'eliminated') p.status = 'in';
  }
  const dealer = st.players.find((p) => p.uid === st.dealerUid);
  if (!dealer || dealer.status === 'eliminated') st.dealerUid = playing[0].uid;
  tx(st, now, seatOf(st, uid), 'admin', 0, `Round ${st.round} started (${Math.round(st.rules.roundMinutes * 60) % 60 ? `${Math.round(st.rules.roundMinutes * 60)} seconds` : `${st.rules.roundMinutes} minutes`})`);
  return [{ e: 'round', round: st.round, endsAt: st.roundEndsAt }, ...beginGame(st, now)];
}

function canContinue(st: State, i: number): boolean {
  const p = st.players[i];
  return p.coins >= st.rules.blindCost || loanLeft(st, i) > 0;
}

function eliminate(st: State, i: number, now: number, ev: GameEvent[]) {
  const p = st.players[i];
  if (p.status === 'eliminated') return;
  p.status = 'eliminated';
  tx(st, now, i, 'eliminated', 0, `Lost ${st.rules.startingCoins + st.rules.maxLoan} coins; folded until Placecut`);
  ev.push({ e: 'eliminated', seat: i });
}

function beginGame(st: State, now: number): GameEvent[] {
  const ev: GameEvent[] = [];
  st.players.forEach((p, i) => {
    if (p.status !== 'eliminated') p.status = 'in';
    if (p.status === 'in' && !canContinue(st, i)) eliminate(st, i, now, ev);
    p.seen = false;
    p.cards = [];
    p.extraBlinds = 0;
    p.contributed = 0;
  });
  if (activeSeats(st).length < st.rules.minPlayers) return ev.concat(enterPlacecut(st, now));
  st.game += 1;
  st.roundGames += 1;
  st.pot = 0;
  st.turn = -1;
  st.result = null;
  st.commit = null;
  st.secret = null;
  st.lastCut = null;
  st.cutBar = null;
  st.dealt = activeSeats(st);
  st.cardsEach = st.wellCut.active ? st.rules.wellCutSequence[st.wellCut.index] : st.rules.normalCards;
  st.phase = 'shuffling';
  st.deadline = null;
  for (const i of st.dealt) st.players[i].rs.games += 1;
  ev.push({ e: 'game', game: st.game, cardsEach: st.cardsEach, wellCutGame: wellCutGameNo(st) });
  return ev;
}

/** True when the server must shuffle a fresh deck and call prepareDeck. */
export const needsDeck = (st: State) => st.phase === 'shuffling';

/**
 * §4 The server has shuffled a fresh 52-card deck. Records the fairness fingerprint.
 * Normal games go to the dealer's cut; Well Cut games 2–4 go straight to dealing.
 */
export function prepareDeck(st: State, deck: Card[], salt: string, commit: string, now: number): GameEvent[] {
  if (st.phase !== 'shuffling') fail('not_shuffling', 'No deck is needed right now.');
  if (deck.length !== 52) fail('bad_deck', 'A full 52-card deck is required.');
  st.secret = { deck: deckString(deck), salt, cards: deck };
  st.commit = commit;
  if (st.wellCut.active) {
    lockCards(st);
    st.phase = 'dealing';
    if (st.timerOn) st.deadline = { kind: 'deal', at: now + st.rules.turnSeconds * 1000 };
  } else {
    st.phase = 'cutting';
    st.cutBar = makeCutBar(st.rules, now);
    if (st.timerOn) st.deadline = { kind: 'cut', at: st.cutBar.startAt + st.rules.turnSeconds * 1000 };
  }
  return [{ e: 'commit', hash: commit }];
}

const BAR_PASSES = 300;

/** A fresh slider: random speed for every pass (crypto randomness), quicker each pass down to a floor. */
export function makeCutBar(rules: DankaRules, now: number): CutBar {
  const durs: number[] = [];
  let d = rules.cutBarPassMs;
  for (let i = 0; i < BAR_PASSES; i++) {
    const j = (cryptoRandInt(2001) - 1000) / 1000; // −1..1
    durs.push(Math.round(d * (1 + j * rules.cutBarJitter)));
    d = Math.max(rules.cutBarPassMs * rules.cutBarFloor, d * rules.cutBarAccel);
  }
  return { startAt: now + rules.cutBarLeadMs, durs, zone: rules.wellCutZone };
}

/**
 * Where the slider is at a moment in time (0 top … 1 bottom). It eases like a pendulum:
 * slow at the ends, fastest through the middle. The same function runs on the server and every phone.
 */
export function barPosition(bar: CutBar, at: number): number {
  let t = Math.max(0, at - bar.startAt);
  const total = bar.durs.reduce((a, b) => a + b, 0);
  if (t >= total) t %= total;
  let i = 0;
  while (t > bar.durs[i]) { t -= bar.durs[i]; i++; }
  const e = 0.5 - 0.5 * Math.cos((Math.PI * t) / bar.durs[i]);
  return i % 2 ? 1 - e : e;
}

/**
 * §4/§5 The player on the dealer's left (the next active player clockwise) stops the Well Cut slider.
 * The dealer only deals.
 */
export function cutterSeat(st: State): number {
  return dealOrder(st)[0] ?? dealerIndex(st);
}

/** Clockwise from the dealer's left, skipping folded/eliminated players. */
export function dealOrder(st: State): number[] {
  const n = st.players.length, d = dealerIndex(st), order: number[] = [];
  for (let k = 1; k <= n; k++) {
    const j = (d + k) % n;
    if (st.players[j].status === 'in') order.push(j);
  }
  return order;
}

/** §4 Round-by-round: one card to each player, then the next round. */
function lockCards(st: State) {
  const deck = st.secret!.cards;
  let k = 0;
  for (let r = 0; r < st.cardsEach; r++) for (const i of dealOrder(st)) st.players[i].cards.push(deck[k++]);
}

/**
 * §5 The dealer stopped the timing bar at server time `at` (the server checks it against when the tap
 * arrived). Within `wellCutZone`% of the middle it is a Well Cut, and the four-game sequence starts
 * with this game. Pass uid null for the automatic stop (timer on).
 */
export function cut(st: State, uid: string | null, at: number, now: number): GameEvent[] {
  if (st.phase !== 'cutting') fail('not_cutting', 'There is nothing to cut right now.');
  if (uid !== null && seatOf(st, uid) !== cutterSeat(st)) fail('not_cutter', 'The player on the dealer’s left cuts.');
  const bar = st.cutBar ?? makeCutBar(st.rules, now);
  const pos = barPosition(bar, at);
  const off = Math.round(Math.abs(pos - 0.5) * 10000) / 100;
  const players = activeSeats(st).length;
  const wellCut = off <= bar.zone;
  st.lastCut = { pos, off, players, wellCut };
  if (wellCut) {
    st.wellCut = { active: true, index: 0 };
    st.wellCutCount += 1;
    st.wellCutsThisRound += 1;
    st.cardsEach = st.rules.wellCutSequence[0];
  }
  lockCards(st);
  st.phase = 'dealing';
  st.deadline = st.timerOn ? { kind: 'deal', at: now + st.rules.turnSeconds * 1000 } : null;
  return [{ e: 'cut', seat: cutterSeat(st), pos, off, players, wellCut, auto: uid === null }];
}

/** The dealer distributes the locked cards. Pass uid null for the automatic deal (timer on). */
export function deal(st: State, uid: string | null, now: number): GameEvent[] {
  if (st.phase !== 'dealing') fail('not_dealing', 'Nothing to deal right now.');
  if (uid !== null && uid !== st.dealerUid) fail('not_dealer', 'Only the dealer deals.');
  const ev: GameEvent[] = [{ e: 'deal', dealer: dealerIndex(st), order: dealOrder(st), cardsEach: st.cardsEach, auto: uid === null }];
  st.phase = 'betting';
  setTurn(st, nextActive(st, dealerIndex(st)), now, ev);
  return ev;
}

/* ------------------------------------------------------------------ */
/* betting (§7–§10)                                                    */
/* ------------------------------------------------------------------ */

export type Action =
  | { type: 'see' }
  | { type: 'blind' }
  | { type: 'seen' }
  | { type: 'pack' }
  | { type: 'show' }
  | { type: 'sideshow' };

function setTurn(st: State, i: number, now: number, ev: GameEvent[]) {
  // §13 A player who cannot pay and has no loan left is knocked out until Placecut.
  let guard = st.players.length + 1;
  while (i >= 0 && !canContinue(st, i) && guard-- > 0) {
    eliminate(st, i, now, ev);
    if (activeSeats(st).length <= 1) return finishGame(st, activeSeats(st)[0], 'all_packed', null, now, ev);
    i = nextActive(st, i);
  }
  st.turn = i;
  st.deadline = st.timerOn ? { kind: 'turn', at: now + st.rules.turnSeconds * 1000 } : null;
  ev.push({ e: 'turn', seat: i });
}

function pay(st: State, i: number, amount: number, type: 'blind' | 'seen' | 'show' | 'sideshow', now: number) {
  const p = st.players[i];
  if (p.coins < amount) {
    if (loanLeft(st, i) > 0) fail('need_loan', `You need ${amount - p.coins} more coin${amount - p.coins === 1 ? '' : 's'}. Take a bank loan to continue.`);
    fail('no_coins', 'You have no coins or loan left.');
  }
  p.coins -= amount;
  p.contributed += amount;
  p.rs.paid += amount;
  st.pot += amount;
  tx(st, now, i, type, -amount);
}

export function act(st: State, uid: string, action: Action, now: number): GameEvent[] {
  if (st.phase !== 'betting') fail('not_betting', 'No game is being played right now.');
  const i = requireSeat(st, uid);
  const p = st.players[i];
  if (p.status !== 'in') fail('not_in_game', 'You are not in this game.');
  const ev: GameEvent[] = [];

  if (action.type === 'see') {
    // §7 Viewing your cards makes you Seen.
    if (p.seen) fail('already_seen', 'You have already seen your cards.');
    p.seen = true;
    return [{ e: 'see', seat: i, auto: false }];
  }

  if (st.turn !== i) fail('not_your_turn', 'It is not your turn.');
  const active = activeSeats(st);

  switch (action.type) {
    case 'pack':
      p.status = 'packed';
      ev.push({ e: 'pack', seat: i, reason: 'choice' });
      break;

    case 'blind': {
      if (p.seen) fail('you_are_seen', 'You have seen your cards, so you play Seen (2 coins).');
      const extra = onlyBlindLeft(st, i);
      pay(st, i, st.rules.blindCost, 'blind', now);
      ev.push({ e: 'bet', seat: i, kind: 'blind', amount: st.rules.blindCost });
      if (extra) {
        p.extraBlinds += 1;
        // §9 After the third extra Blind action the cards are revealed and the player becomes Seen.
        if (p.extraBlinds >= st.rules.extraBlindActions) {
          p.seen = true;
          ev.push({ e: 'see', seat: i, auto: true });
        }
      }
      break;
    }

    case 'seen':
      if (!p.seen) fail('you_are_blind', 'You are Blind. Play Blind (1 coin) or look at your cards first.');
      pay(st, i, st.rules.seenCost, 'seen', now);
      ev.push({ e: 'bet', seat: i, kind: 'seen', amount: st.rules.seenCost });
      break;

    case 'show': {
      // §8 Only when two players remain. A Blind player may Show only when the other is Seen.
      if (active.length !== 2) fail('show_not_allowed', 'Show is allowed only when two players remain. Use Sideshow when everyone is Seen.');
      const other = active.find((j) => j !== i)!;
      if (!p.seen && !st.players[other].seen) fail('blind_show', 'A Blind player can Show only after the other player is Seen.');
      const cost = costFor(st, i);
      pay(st, i, cost, 'show', now);
      ev.push({ e: 'bet', seat: i, kind: 'show', amount: cost });
      const a = i, b = other;
      const ha = evaluate(st.players[a].cards), hb = evaluate(st.players[b].cards);
      const winner = compareHands(ha, hb) > 0 ? a : b;
      st.players[a === winner ? b : a].status = 'packed';
      ev.push({ e: 'show', a, b, winner });
      const show: ShowInfo = { a, b, aCards: st.players[a].cards.map(cardCode), bCards: st.players[b].cards.map(cardCode), aHand: ha, bHand: hb };
      finishGame(st, winner, 'show', show, now, ev);
      return ev;
    }

    case 'sideshow': {
      // §10 Only when every active player is Seen; only with the next active player on the left;
      // compulsory; compared privately; the weaker hand is folded.
      if (!allActiveSeen(st)) fail('sideshow_locked', 'Sideshow opens when every active player is Seen.');
      if (active.length < 3) fail('use_show', 'Only two players remain: use Show.');
      const target = nextActive(st, i);
      pay(st, i, st.rules.sideshowCost, 'sideshow', now);
      ev.push({ e: 'bet', seat: i, kind: 'sideshow', amount: st.rules.sideshowCost });
      const hi = evaluate(p.cards), ht = evaluate(st.players[target].cards);
      const loser = compareHands(hi, ht) > 0 ? target : i;
      st.players[loser].status = 'packed';
      ev.push({ e: 'sideshow', from: i, to: target, loser });
      break;
    }

    default:
      fail('bad_action', 'Unknown action.');
  }
  advance(st, i, now, ev);
  return ev;
}

function advance(st: State, from: number, now: number, ev: GameEvent[]) {
  const active = activeSeats(st);
  if (active.length === 1) return finishGame(st, active[0], 'all_packed', null, now, ev);
  setTurn(st, nextActive(st, from), now, ev);
}

/** §13 Borrow from the central bank. Cumulative loans never exceed the limit. */
export function takeLoan(st: State, uid: string, amount: number, now: number): GameEvent[] {
  const i = requireSeat(st, uid);
  const p = st.players[i];
  if (p.status === 'eliminated') fail('eliminated', 'You are out until Placecut.');
  if (st.phase === 'ended') fail('room_closed', 'The session has ended.');
  const a = Math.floor(amount);
  if (!(a >= 1)) fail('bad_amount', 'Choose how many coins to borrow.');
  if (a > loanLeft(st, i)) fail('loan_limit', `You can borrow at most ${loanLeft(st, i)} more coins.`);
  p.coins += a;
  p.loan += a;
  p.rs.loans += a;
  st.loansThisRound += a;
  tx(st, now, i, 'loan', a, `Bank loan (total ${p.loan}/${st.rules.maxLoan})`);
  return [{ e: 'loan', seat: i, amount: a }];
}

/** Bonus payments are owed, so a short player borrows what they can automatically, then pays what they have. */
function payBonus(st: State, j: number, owed: number, now: number): number {
  const p = st.players[j];
  if (p.coins < owed) {
    const borrow = Math.min(owed - p.coins, loanLeft(st, j));
    if (borrow > 0) {
      p.coins += borrow; p.loan += borrow; p.rs.loans += borrow; st.loansThisRound += borrow;
      tx(st, now, j, 'loan', borrow, 'Automatic loan to pay a bonus');
    }
  }
  const paid = Math.min(owed, p.coins);
  p.coins -= paid;
  p.rs.paid += paid;
  p.rs.bonusOut += paid;
  tx(st, now, j, 'bonus_out', -paid, paid < owed ? `Owed ${owed}, had ${paid}` : undefined);
  return paid;
}

function finishGame(st: State, winner: number, reason: 'all_packed' | 'show', show: ShowInfo | null, now: number, ev: GameEvent[]) {
  const w = st.players[winner];
  const pot = st.pot;
  w.coins += pot;
  w.rs.received += pot;
  w.rs.winnings += pot;
  tx(st, now, winner, 'pot_win', pot, reason === 'show' ? 'Won at Show' : 'Everyone else folded');
  for (const j of st.dealt) if (j !== winner) st.players[j].rs.losses += st.players[j].contributed;
  st.pot = 0;
  ev.push({ e: 'win', seat: winner, pot, reason });

  // §11 Three of a Kind (normal 3-card game) / Four of a Kind (Well Cut game 1): paid only when the holder wins.
  const wcGame = wellCutGameNo(st);
  const hand = evaluate(w.cards);
  let bonus: GameResult['bonus'] = null;
  // §6/§9 Three of a Kind pays in every 3-card game, Well Cut game 2 included; Four of a Kind in the 4-card game.
  const trail = st.cardsEach === 3 && hand.trail;
  const quad = wcGame === 1 && st.cardsEach === 4 && hand.quad;
  if (trail || quad) {
    const n = st.dealt.length;
    let total = 0;
    for (const j of st.dealt) if (j !== winner) total += payBonus(st, j, n, now);
    w.coins += total;
    w.rs.received += total;
    w.rs.bonusIn += total;
    tx(st, now, winner, 'bonus_in', total, `${trail ? 'Three' : 'Four'} of a Kind bonus: ${n} × ${n - 1}`);
    bonus = { kind: trail ? 'trail' : 'quad', total, each: n };
    ev.push({ e: 'bonus', seat: winner, kind: bonus.kind, total, each: n });
  }

  st.result = {
    round: st.round, game: st.game, winner, winnerName: w.name, pot, reason, show, bonus,
    cardsEach: st.cardsEach, wellCutGame: wcGame, commit: st.commit!, deck: st.secret!.deck, salt: st.secret!.salt,
  };
  st.history.push({ round: st.round, game: st.game, winner: w.name, pot, bonus: bonus?.total ?? 0, cardsEach: st.cardsEach, wellCutGame: wcGame, reason, at: now });
  st.dealerUid = w.uid; // §12 the winner deals next
  if (st.wellCut.active) {
    st.wellCut.index += 1;
    if (st.wellCut.index >= st.rules.wellCutSequence.length) st.wellCut = { active: false, index: 0 };
  }
  // §13 Anyone who has now lost everything, including the full loan, is out until Placecut.
  st.players.forEach((p, i) => { if (p.status !== 'eliminated' && !canContinue(st, i)) eliminate(st, i, now, ev); });
  st.turn = -1;
  st.phase = 'game_over';
  st.deadline = { kind: 'next_game', at: now + st.rules.nextGameSeconds * 1000 };
}

/** After a game: next game, or Placecut when the 20 minutes are up, or the end when called off. */
export function nextGame(st: State, now: number): GameEvent[] {
  if (st.phase !== 'game_over') fail('not_over', 'The game is still being played.');
  if (st.callOff) return endSession(st, now);
  // §5 The Well Cut sequence cannot be interrupted, so the round only ends between sequences.
  if (st.roundEndsAt !== null && now >= st.roundEndsAt && !st.wellCut.active) return enterPlacecut(st, now);
  return beginGame(st, now);
}

function buildScorecard(st: State, now: number, final: boolean): Scorecard {
  const rows = st.players.map((p) => rowFor(st, p, false));
  return {
    round: st.round, at: now, final, games: st.history.length, results: [...st.history],
    totalPot: st.history.reduce((a, g) => a + g.pot, 0), totalBonus: st.history.reduce((a, g) => a + g.bonus, 0),
    wellCuts: st.wellCutsThisRound, loansIssued: st.loansThisRound, rows: [...rows, ...st.departed.filter(() => final)],
  };
}

function enterPlacecut(st: State, now: number): GameEvent[] {
  st.phase = 'placecut';
  st.turn = -1;
  st.deadline = null;
  st.roundEndsAt = null;
  const card = buildScorecard(st, now, false);
  st.scorecards.push(card);
  st.players.forEach((p, i) => tx(st, now, i, 'placecut', 0, `Round ${st.round} settlement: balance ${p.coins}, loan ${p.loan}, net ${p.coins - st.rules.startingCoins - p.loan}`));
  return [{ e: 'placecut', round: st.round }];
}

function endSession(st: State, now: number): GameEvent[] {
  if (st.round > 0) {
    const card = buildScorecard(st, now, true);
    if (st.scorecards.at(-1)?.round === st.round) st.scorecards[st.scorecards.length - 1] = card;
    else st.scorecards.push(card);
  }
  st.phase = 'ended';
  st.deadline = null;
  st.turn = -1;
  return [{ e: 'ended' }];
}

/** §14/§16 The admin calls off the session; a game in progress finishes first. */
export function callOff(st: State, uid: string, now: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can call off the session.');
  if (st.phase === 'ended') return [];
  tx(st, now, seatOf(st, uid), 'admin', 0, 'Session called off');
  if (st.phase === 'lobby' || st.phase === 'placecut' || st.phase === 'game_over') return endSession(st, now);
  st.callOff = true;
  return [{ e: 'call_off' }];
}

/** Runs whatever is due: next game, and (timer on) auto-cut, auto-deal or auto-pack. */
export function onDeadline(st: State, now: number): GameEvent[] {
  const d = st.deadline;
  if (!d || now < d.at) return [];
  switch (d.kind) {
    case 'next_game':
      return st.phase === 'game_over' ? nextGame(st, now) : [];
    case 'cut':
      return st.phase === 'cutting' ? cut(st, null, now, now) : [];
    case 'deal':
      return st.phase === 'dealing' ? deal(st, null, now) : [];
    case 'turn': {
      if (st.phase !== 'betting' || st.turn < 0) return [];
      const ev: GameEvent[] = [];
      const i = st.turn;
      st.players[i].status = 'packed';
      ev.push({ e: 'pack', seat: i, reason: 'timeout' });
      advance(st, i, now, ev);
      return ev;
    }
  }
}

/* ------------------------------------------------------------------ */
/* what each phone may see                                             */
/* ------------------------------------------------------------------ */

export interface PlayerView {
  phase: Phase;
  you: number;
  isAdmin: boolean;
  round: number;
  roundEndsAt: number | null;
  callOff: boolean;
  timerOn: boolean;
  tableSize: number;
  minPlayers: number;
  maxPlayers: number;
  game: number;
  roundGames: number;
  dealer: number;
  /** Who stops the Well Cut slider: the player on the dealer's left. */
  cutter: number;
  turn: number;
  pot: number;
  cardsEach: number;
  wellCut: { active: boolean; game: number | null; sequence: number[] };
  wellCutCount: number;
  wellCutsThisRound: number;
  lastCut: CutInfo | null;
  /** The timing bar while the dealer cuts: every phone draws the same slider from this. */
  cutBar: CutBar | null;
  rules: { blind: number; seen: number; sideshow: number; maxLoan: number; startingCoins: number; extraBlinds: number; turnSeconds: number; wellCutZone: number };
  players: {
    name: string; coins: number; loan: number; status: PlayerStatus; seen: boolean; connected: boolean;
    cardCount: number; cards: string[] | null; isAdmin: boolean; isDealer: boolean;
    /** Extra Blind actions left (§9), when this player is the only Blind one left. */
    extraBlindsLeft: number | null;
  }[];
  commit: string | null;
  result: GameResult | null;
  deadline: Deadline | null;
  scorecard: Scorecard | null;
  ledger: Tx[];
  yourHand: string | null;
  options: {
    see: boolean; blind: boolean; seen: boolean; pack: boolean;
    show: number | null; sideshow: { cost: number; target: number } | null;
    cut: boolean; deal: boolean;
    loan: { left: number; needed: number } | null;
    startRound: boolean; callOff: boolean; leave: boolean; tableSize: boolean;
  };
}

export function viewFor(st: State, uid: string): PlayerView {
  const me = seatOf(st, uid);
  const mine = me >= 0 ? st.players[me] : null;
  const over = st.phase === 'game_over' || st.phase === 'placecut' || st.phase === 'ended';
  const shown = over && st.result?.show && st.result.game === st.game ? [st.result.show.a, st.result.show.b] : [];
  const d = dealerIndex(st);
  const myTurn = st.phase === 'betting' && st.turn === me && mine?.status === 'in';
  const active = activeSeats(st);
  const isAdmin = uid === st.adminUid;
  const cost = me >= 0 ? costFor(st, me) : 0;
  let show: number | null = null;
  if (myTurn && active.length === 2) {
    const other = active.find((j) => j !== me)!;
    if (mine!.seen || st.players[other].seen) show = cost;
  }
  const sideshow = myTurn && active.length >= 3 && allActiveSeen(st) ? { cost: st.rules.sideshowCost, target: nextActive(st, me) } : null;
  const needed = myTurn ? Math.max(0, cost - mine!.coins) : 0;
  const between = st.phase === 'lobby' || st.phase === 'placecut';
  const lastCard = st.scorecards.at(-1) ?? null;
  return {
    phase: st.phase, you: me, isAdmin, round: st.round, roundEndsAt: st.roundEndsAt, callOff: st.callOff, timerOn: st.timerOn,
    tableSize: st.tableSize, minPlayers: st.rules.minPlayers, maxPlayers: st.rules.maxPlayers,
    game: st.game, roundGames: st.roundGames, dealer: d, cutter: cutterSeat(st), turn: st.turn, pot: st.pot, cardsEach: st.cardsEach,
    wellCut: { active: st.wellCut.active, game: wellCutGameNo(st), sequence: st.rules.wellCutSequence },
    wellCutCount: st.wellCutCount, wellCutsThisRound: st.wellCutsThisRound,
    lastCut: st.phase === 'cutting' ? null : st.lastCut,
    cutBar: st.phase === 'cutting' ? st.cutBar : null,
    rules: { blind: st.rules.blindCost, seen: st.rules.seenCost, sideshow: st.rules.sideshowCost, maxLoan: st.rules.maxLoan, startingCoins: st.rules.startingCoins, extraBlinds: st.rules.extraBlindActions, turnSeconds: st.rules.turnSeconds, wellCutZone: st.rules.wellCutZone },
    players: st.players.map((p, i) => ({
      name: p.name, coins: p.coins, loan: p.loan, status: p.status, seen: p.seen, connected: p.connected,
      cardCount: p.cards.length, cards: i === me || shown.includes(i) ? p.cards.map(cardCode) : null,
      isAdmin: p.uid === st.adminUid, isDealer: i === d,
      extraBlindsLeft: st.phase === 'betting' && onlyBlindLeft(st, i) ? Math.max(0, st.rules.extraBlindActions - p.extraBlinds) : null,
    })),
    commit: st.commit,
    result: over ? st.result : null,
    deadline: st.deadline,
    scorecard: st.phase === 'placecut' || st.phase === 'ended' ? lastCard : null,
    ledger: st.ledger.slice(-80),
    yourHand: mine && mine.seen && mine.cards.length ? evaluate(mine.cards).name : null,
    options: {
      see: st.phase === 'betting' && mine?.status === 'in' && !mine.seen,
      blind: myTurn && !mine!.seen,
      seen: myTurn && mine!.seen,
      pack: myTurn,
      show,
      sideshow,
      cut: st.phase === 'cutting' && me >= 0 && me === cutterSeat(st),
      deal: st.phase === 'dealing' && mine?.uid === st.dealerUid,
      loan: mine && mine.status !== 'eliminated' && st.phase !== 'ended' && loanLeft(st, me) > 0 ? { left: loanLeft(st, me), needed } : null,
      startRound: isAdmin && between && st.players.filter((p) => p.status !== 'eliminated').length >= st.rules.minPlayers,
      callOff: isAdmin && st.phase !== 'ended' && !st.callOff,
      leave: !!mine && !isAdmin && (between || st.phase === 'ended'),
      tableSize: isAdmin && between,
    },
  };
}

/** Full session report for the PDF (admin). */
export function sessionReport(st: State) {
  return {
    createdAt: st.createdAt, rounds: st.round, games: st.game, wellCuts: st.wellCutCount,
    scorecards: st.scorecards,
    players: st.players.map((p) => rowFor(st, p, false)),
    departed: st.departed,
  };
}
