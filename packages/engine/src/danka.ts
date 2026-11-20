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
  | 'placecut' // 20-minute period over and the current game finished: settlement, leave/join, admin starts the next period
  | 'ended'; // tournament called off

/** 'eliminated' = sitting out: no coins, bank loan used up, and no player loan yet. Stays at the table. */
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
  /** Balance when the current 20-minute period started. */
  roundStartCoins: number;
  /** Balance when the current game started. */
  gameStartCoins: number;
  rs: RoundStats;
}

export type TxType =
  | 'initial' | 'blind' | 'seen' | 'show' | 'sideshow' | 'pot_win' | 'bonus_in' | 'bonus_out'
  | 'loan' | 'p2p_in' | 'p2p_out' | 'eliminated' | 'placecut' | 'leave' | 'admin';

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
  /** Coins borrowed from other players and still owed (liability). */
  owesPlayers: number;
  /** Coins lent to other players and still owed to this player. */
  owedByPlayers: number;
  /** Balance change in this game. */
  change: number;
  /** Balance change since the current 20-minute period started. */
  periodChange: number;
  /** Balance − initial allocation − bank loan − owed to players + owed by players. */
  net: number;
  eliminated: boolean;
  left: boolean;
  games: number;
}

/** A settlement: after each game ('game'), at each Placecut ('placecut'), or at call-off ('final'). Tournament totals; nothing resets. */
export interface Scorecard {
  kind: 'game' | 'placecut' | 'final';
  /** The game this settlement follows. */
  round: number;
  /** The 20-minute period. */
  period: number;
  at: number;
  final: boolean;
  /** Games played in the tournament so far. */
  games: number;
  /** This game's result. */
  results: GameRecord[];
  totalPot: number;
  totalBonus: number;
  wellCuts: number;
  /** Bank loans issued in the tournament. */
  loansIssued: number;
  /** Outstanding player-to-player loans. */
  loans: P2PLoan[];
  /** Every player loan made in the tournament: lender, borrower, amount, game and time. */
  loanLog: P2PLogEntry[];
  rows: ScoreRow[];
}

export interface P2PLogEntry {
  borrower: string;
  lender: string;
  amount: number;
  game: number;
  at: number;
}

/** An outstanding player-to-player loan: existing coins moved from lender to borrower (never new coins). */
export interface P2PLoan {
  borrower: string;
  borrowerName: string;
  lender: string;
  lenderName: string;
  amount: number;
}

/** A borrower's request to one lender, waiting for accept or decline. */
export interface LoanRequest {
  id: number;
  from: string;
  to: string;
  amount: number;
  at: number;
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
  | { e: 'start'; game: number }
  | { e: 'period'; round: number; endsAt: number }
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
  | { e: 'p2p_request'; id: number; from: number; to: number; amount: number }
  | { e: 'p2p_answer'; id: number; from: number; to: number; amount: number; accepted: boolean }
  | { e: 'p2p_cancel'; id: number; from: number; to: number }
  | { e: 'sitout'; seat: number }
  | { e: 'placecut'; round: number }
  | { e: 'ended' }
  | { e: 'timer'; on: boolean }
  | { e: 'call_off' }
  | { e: 'table_size'; size: number };

export interface State {
  v: 4;
  rules: DankaRules;
  createdAt: number;
  adminUid: string;
  tableSize: number;
  players: Player[];
  departed: ScoreRow[];
  phase: Phase;
  round: number;
  /** §14 Server time when the current 20-minute period ends; then Placecut follows the current game. */
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
  /** Bank loans issued in the tournament. */
  bankLoansTotal: number;
  totalPot: number;
  totalBonus: number;
  /** The last Blind or Seen bet in this game (no two consecutive Blind players when 3+ are active). */
  lastBet: { seat: number; kind: 'blind' | 'seen' } | null;
  /** Someone has played Seen in this game: from then on, no two consecutive Blind players (3+ active). */
  seenStarted: boolean;
  p2pLog: P2PLogEntry[];
  /** Outstanding player-to-player loans, one entry per borrower → lender pair. */
  p2p: P2PLoan[];
  requests: LoanRequest[];
  reqSeq: number;
  /** "borrower>lender" pairs declined in the current game (so a borrower moves on to someone else). */
  declines: string[];
  lastCut: CutInfo | null;
  cutBar: CutBar | null;
  commit: string | null;
  /** Server-only: the current deck and salt. Never sent to phones before the game ends. */
  secret: { deck: string; salt: string; cards: Card[] } | null;
  result: GameResult | null;
  deadline: Deadline | null;
  /** Recent games (the full list is in the saved settlements). */
  history: GameRecord[];
  /** Recent settlements (all of them are saved by the server from cardOutbox). */
  scorecards: Scorecard[];
  cardOutbox: Scorecard[];
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
const HISTORY_TAIL = 60;
const CARDS_TAIL = 3;
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

/**
 * Blind/Seen rotation (corrected local rule). Before anyone in this game has played Seen, Blind is unrestricted.
 * After the first Seen, with three or more active players, a Blind bet forces the next active player to play
 * Seen; if that player folds, the next active player must play Seen. With two players left it is removed.
 */
export const mustPlaySeen = (st: State, i: number) =>
  !st.players[i].seen && st.seenStarted && activeSeats(st).length >= 3 && st.lastBet?.kind === 'blind' && st.lastBet.seat !== i;
/** §14 The 20 minutes are up (and no Well Cut sequence is running): Placecut follows the current game. */
export const placecutDue = (st: State, now: number) => st.roundEndsAt !== null && now >= st.roundEndsAt && !st.wellCut.active;
export const costFor = (st: State, i: number) => (st.players[i].seen || mustPlaySeen(st, i) ? st.rules.seenCost : st.rules.blindCost);
export const loanLeft = (st: State, i: number) => Math.max(0, st.rules.maxLoan - st.players[i].loan);
/** §9 True when this Blind player is the only Blind one left among 3+ active players (no limit with two). */
export const onlyBlindLeft = (st: State, i: number) =>
  !st.players[i].seen && st.players[i].status === 'in' && activeSeats(st).length >= 3 && activeSeats(st).every((j) => j === i || st.players[j].seen);
/** Can sit down for a game: enough for a Blind, or bank loan left. */
const canPlay = (st: State, i: number) => st.players[i].coins >= st.rules.blindCost || loanLeft(st, i) > 0;
/** Final lending rule: used all 200 coins (bank loan used up, not enough for a Seen turn) → may borrow from players. */
export const canBorrowFromPlayers = (st: State, i: number) =>
  loanLeft(st, i) === 0 && st.players[i].coins < st.rules.seenCost;
export const owesPlayers = (st: State, uid: string) => st.p2p.filter((l) => l.borrower === uid).reduce((a, l) => a + l.amount, 0);
export const owedByPlayers = (st: State, uid: string) => st.p2p.filter((l) => l.lender === uid).reduce((a, l) => a + l.amount, 0);
/** §14 Players join or leave only before the first period or at Placecut. */
const atBoundary = (st: State) => st.phase === 'lobby' || st.phase === 'placecut';
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
    extraBlinds: 0, contributed: 0, joinedRound: st.round, roundStartCoins: st.rules.startingCoins, gameStartCoins: st.rules.startingCoins, rs: emptyStats(),
  };
  return p;
}

/* ------------------------------------------------------------------ */
/* room, players, admin                                                */
/* ------------------------------------------------------------------ */

export function createRoom(opts: { rules: DankaRules; admin: { uid: string; name: string }; now: number; tableSize?: number }): State {
  const r = opts.rules;
  const st: State = {
    v: 4, rules: { ...r, wellCutSequence: [...r.wellCutSequence] }, createdAt: opts.now, adminUid: opts.admin.uid,
    tableSize: Math.max(r.minPlayers, Math.min(r.maxPlayers, MAX_SEATS, Math.round(opts.tableSize ?? r.maxPlayers))),
    players: [], departed: [], phase: 'lobby', round: 0, roundEndsAt: null, callOff: false, timerOn: false,
    game: 0, roundGames: 0, dealerUid: opts.admin.uid, turn: -1, pot: 0, cardsEach: r.normalCards, dealt: [],
    wellCut: { active: false, index: 0 }, wellCutCount: 0, bankLoansTotal: 0, totalPot: 0, totalBonus: 0, lastBet: null, seenStarted: false, p2pLog: [],
    p2p: [], requests: [], reqSeq: 0, declines: [], lastCut: null, cutBar: null,
    commit: null, secret: null, result: null, deadline: null, history: [], scorecards: [], cardOutbox: [], ledger: [], outbox: [], txSeq: 0,
  };
  join(st, opts.admin.uid, opts.admin.name, opts.now);
  return st;
}

/** §2 Join, or reconnect to your own seat. New players join only before the first game or at a settlement. */
/** Computer players have uids starting with this prefix; they are seated and played by the server. */
export const BOT_PREFIX = 'cpu:';
export const isBotUid = (uid: string) => uid.startsWith(BOT_PREFIX);

export function join(st: State, uid: string, name: string, now: number): { seat: number; events: GameEvent[] } {
  const existing = seatOf(st, uid);
  if (existing >= 0) {
    st.players[existing].connected = true;
    return { seat: existing, events: [{ e: 'joined', seat: existing, name: st.players[existing].name, rejoined: true }] };
  }
  if (st.phase === 'ended') fail('room_closed', 'This session has ended.');
  if (!atBoundary(st)) fail('round_in_progress', 'The tournament is in a 20-minute period. You can join at the next Placecut.');
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
  const owes = owesPlayers(st, p.uid), owed = owedByPlayers(st, p.uid);
  return {
    name: p.name, startBalance: p.roundStartCoins, received: p.rs.received, paid: p.rs.paid, winnings: p.rs.winnings, losses: p.rs.losses,
    balance: p.coins, initial: st.rules.startingCoins, loanTotal: p.rs.loans, outstandingLoan: p.loan, bonusIn: p.rs.bonusIn, bonusOut: p.rs.bonusOut,
    owesPlayers: owes, owedByPlayers: owed, change: p.coins - p.gameStartCoins, periodChange: p.coins - p.roundStartCoins,
    net: p.coins - st.rules.startingCoins - p.loan - owes + owed, eliminated: p.status === 'eliminated', left, games: p.rs.games,
  };
}

/** Leave the room: only before the first game or at a settlement. History, bank loans and player loans stay recorded. */
export function leave(st: State, uid: string, now: number): GameEvent[] {
  const i = requireSeat(st, uid);
  if (uid === st.adminUid) fail('admin_cannot_leave', 'The admin calls off the tournament instead of leaving.');
  if (!atBoundary(st) && st.phase !== 'ended') fail('round_in_progress', 'You can leave at the next Placecut, when the 20 minutes are up.');
  const p = st.players[i];
  st.requests = st.requests.filter((r) => r.from !== uid && r.to !== uid);
  tx(st, now, i, 'leave', 0, `Left with ${p.coins} coins, bank loan ${p.loan}, owes players ${owesPlayers(st, uid)}, owed ${owedByPlayers(st, uid)}`);
  st.departed.push(rowFor(st, p, true));
  st.players.splice(i, 1);
  return [{ e: 'left', name: p.name }];
}

export function setTableSize(st: State, uid: string, size: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can change the table size.');
  if (!atBoundary(st)) fail('round_in_progress', 'Change the table size at Placecut.');
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
/* games and settlements                                               */
/* ------------------------------------------------------------------ */

/**
 * The admin starts the next game.
 * - From the waiting room or a Placecut: a new 20-minute period begins (§14).
 * - After a game (its settlement is on screen): the next game of the same period, or the Placecut if the
 *   20 minutes are up. Nothing resets: balances, loans, bonuses and statistics carry forward.
 */
export function startGame(st: State, uid: string, now: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can start the next game.');
  if (st.phase === 'game_over') {
    if (st.callOff) return endSession(st, now);
    if (placecutDue(st, now)) return enterPlacecut(st, now);
    return startNext(st, now);
  }
  if (st.phase !== 'lobby' && st.phase !== 'placecut') fail('round_in_progress', 'A game is already being played.');
  const playable = st.players.filter((_, i) => canPlay(st, i));
  if (playable.length < st.rules.minPlayers) fail('not_enough_players', `At least ${st.rules.minPlayers} players with coins are needed.`);
  st.round += 1;
  st.roundEndsAt = now + st.rules.roundMinutes * 60_000;
  st.roundGames = 0;
  st.callOff = false;
  for (const p of st.players) p.roundStartCoins = p.coins;
  tx(st, now, seatOf(st, uid), 'admin', 0, `20-minute period ${st.round} started`);
  return [{ e: 'period', round: st.round, endsAt: st.roundEndsAt }, ...startNext(st, now)];
}

function startNext(st: State, now: number): GameEvent[] {
  const playable = st.players.filter((_, i) => canPlay(st, i));
  if (playable.length < st.rules.minPlayers) return enterPlacecut(st, now);
  const dealer = st.players.findIndex((p) => p.uid === st.dealerUid);
  if (dealer < 0 || !canPlay(st, dealer)) st.dealerUid = playable[0].uid;
  return [{ e: 'start', game: st.game + 1 }, ...beginGame(st, now)];
}

function beginGame(st: State, now: number): GameEvent[] {
  const ev: GameEvent[] = [];
  st.players.forEach((p, i) => {
    // A player with no coins and no bank loan left sits this game out (they can still borrow from players).
    if (canPlay(st, i)) p.status = 'in';
    else {
      if (p.status !== 'eliminated') tx(st, now, i, 'eliminated', 0, 'No coins and bank loan used up: sits this game out');
      p.status = 'eliminated';
      ev.push({ e: 'sitout', seat: i });
    }
    p.seen = false;
    p.gameStartCoins = p.coins;
    p.cards = [];
    p.extraBlinds = 0;
    p.contributed = 0;
  });
  if (activeSeats(st).length < st.rules.minPlayers) return ev.concat(enterPlacecut(st, now));
  st.game += 1;
  st.roundGames += 1;
  st.pot = 0;
  st.lastBet = null;
  st.seenStarted = false;
  st.declines = [];
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
  // A player who can't pay waits on their turn: take a bank loan, borrow from a player, or pack.
  st.turn = i;
  st.deadline = st.timerOn ? { kind: 'turn', at: now + st.rules.turnSeconds * 1000 } : null;
  ev.push({ e: 'turn', seat: i });
}

function pay(st: State, i: number, amount: number, type: 'blind' | 'seen' | 'show' | 'sideshow', now: number) {
  const p = st.players[i];
  if (p.coins < amount) {
    if (loanLeft(st, i) > 0) fail('need_loan', `You need ${amount - p.coins} more coin${amount - p.coins === 1 ? '' : 's'}. Take a bank loan to continue.`);
    fail('need_player_loan', 'Your bank loan is used up. Borrow from another player, or pack.');
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
      if (mustPlaySeen(st, i)) fail('must_play_seen', 'The player before you played Blind, so you must play Seen (2 coins) or pack.');
      const extra = onlyBlindLeft(st, i);
      pay(st, i, st.rules.blindCost, 'blind', now);
      st.lastBet = { seat: i, kind: 'blind' };
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

    case 'seen': {
      const forced = mustPlaySeen(st, i);
      if (!p.seen && !forced) fail('you_are_blind', 'You are Blind. Play Blind (1 coin) or look at your cards first.');
      pay(st, i, st.rules.seenCost, 'seen', now);
      if (!p.seen) { p.seen = true; ev.push({ e: 'see', seat: i, auto: false }); }
      st.lastBet = { seat: i, kind: 'seen' };
      st.seenStarted = true;
      ev.push({ e: 'bet', seat: i, kind: 'seen', amount: st.rules.seenCost });
      break;
    }

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
      st.lastBet = { seat: i, kind: 'seen' };
      st.seenStarted = true;
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
  if (st.phase === 'ended') fail('room_closed', 'The tournament has ended.');
  const a = Math.floor(amount);
  if (!(a >= 1)) fail('bad_amount', 'Choose how many coins to borrow.');
  if (a > loanLeft(st, i)) fail('loan_limit', `You can borrow at most ${loanLeft(st, i)} more coins.`);
  p.coins += a;
  p.loan += a;
  p.rs.loans += a;
  st.bankLoansTotal += a;
  tx(st, now, i, 'loan', a, `Bank loan (total ${p.loan}/${st.rules.maxLoan})`);
  return [{ e: 'loan', seat: i, amount: a }];
}

/* ------------------------------------------------------------------ */
/* Final lending rule: player-to-player loans                          */
/* ------------------------------------------------------------------ */

/**
 * A player who has used all 200 coins asks one other player for any amount. Valid only if that player
 * has at least that many coins. One open request at a time; after a decline they can ask someone else.
 */
export function requestPlayerLoan(st: State, uid: string, lenderSeat: number, amount: number, now: number): GameEvent[] {
  const i = requireSeat(st, uid);
  if (st.phase === 'ended') fail('room_closed', 'The tournament has ended.');
  if (!canBorrowFromPlayers(st, i)) fail('not_eligible', 'You can borrow from players after using all 200 coins (your 100 and the full bank loan).');
  const lender = st.players[lenderSeat];
  if (!lender || lenderSeat === i) fail('bad_lender', 'Choose another player to ask.');
  const a = Math.floor(amount);
  if (!(a >= 1)) fail('bad_amount', 'Choose how many coins to borrow.');
  if (a > lender.coins) fail('lender_short', `${lender.name} has only ${lender.coins} coins available.`);
  if (st.requests.some((r) => r.from === uid)) fail('request_open', 'Wait for an answer, or cancel your request first.');
  const r: LoanRequest = { id: ++st.reqSeq, from: uid, to: lender.uid, amount: a, at: now };
  st.requests.push(r);
  return [{ e: 'p2p_request', id: r.id, from: i, to: lenderSeat, amount: a }];
}

/** The lender accepts (coins move at once) or declines. */
export function answerPlayerLoan(st: State, uid: string, id: number, accept: boolean, now: number): GameEvent[] {
  const k = st.requests.findIndex((r) => r.id === id);
  if (k < 0) fail('no_request', 'That request is no longer open.');
  const r = st.requests[k];
  if (r.to !== uid) fail('not_lender', 'This request is not for you.');
  const li = seatOf(st, r.to), bi = seatOf(st, r.from);
  if (accept && st.players[li].coins < r.amount) fail('lender_short', `You have only ${st.players[li].coins} coins available now.`);
  st.requests.splice(k, 1);
  if (bi < 0) return [];
  if (!accept) {
    st.declines.push(`${r.from}>${r.to}`);
    return [{ e: 'p2p_answer', id, from: bi, to: li, amount: r.amount, accepted: false }];
  }
  const lender = st.players[li], borrower = st.players[bi];
  // Existing coins move from lender to borrower; no new coins are created.
  lender.coins -= r.amount;
  borrower.coins += r.amount;
  const loan = st.p2p.find((l) => l.borrower === borrower.uid && l.lender === lender.uid);
  if (loan) loan.amount += r.amount;
  else st.p2p.push({ borrower: borrower.uid, borrowerName: borrower.name, lender: lender.uid, lenderName: lender.name, amount: r.amount });
  st.p2pLog.push({ borrower: borrower.name, lender: lender.name, amount: r.amount, game: st.game, at: now });
  tx(st, now, li, 'p2p_out', -r.amount, `Lent to ${borrower.name}`);
  tx(st, now, bi, 'p2p_in', r.amount, `Borrowed from ${lender.name} (owes ${owesPlayers(st, borrower.uid)} to players)`);
  return [{ e: 'p2p_answer', id, from: bi, to: li, amount: r.amount, accepted: true }];
}

/** The borrower withdraws an open request. */
export function cancelPlayerLoan(st: State, uid: string): GameEvent[] {
  const k = st.requests.findIndex((r) => r.from === uid);
  if (k < 0) return [];
  const r = st.requests[k];
  st.requests.splice(k, 1);
  return [{ e: 'p2p_cancel', id: r.id, from: seatOf(st, r.from), to: seatOf(st, r.to) }];
}

/** Bonus payments are owed, so a short player borrows what they can automatically, then pays what they have. */
function payBonus(st: State, j: number, owed: number, now: number): number {
  const p = st.players[j];
  if (p.coins < owed) {
    const borrow = Math.min(owed - p.coins, loanLeft(st, j));
    if (borrow > 0) {
      p.coins += borrow; p.loan += borrow; p.rs.loans += borrow; st.bankLoansTotal += borrow;
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
  if (st.history.length > HISTORY_TAIL) st.history.splice(0, st.history.length - HISTORY_TAIL);
  st.totalPot += pot;
  st.totalBonus += bonus?.total ?? 0;
  st.dealerUid = w.uid; // §12 the winner deals next
  if (st.wellCut.active) {
    st.wellCut.index += 1;
    if (st.wellCut.index >= st.rules.wellCutSequence.length) st.wellCut = { active: false, index: 0 };
  }
  st.turn = -1;
  st.phase = 'game_over';
  // Individual game settlement (not a Placecut).
  saveCard(st, buildScorecard(st, now, 'game'));
  // The admin starts the next game. If the 20 minutes are up (or the tournament was called off), the
  // Placecut (or the final settlement) follows on its own after a short look at the result.
  st.deadline = st.callOff || placecutDue(st, now)
    ? { kind: 'next_game', at: now + st.rules.nextGameSeconds * 1000 }
    : st.roundEndsAt !== null && !st.wellCut.active ? { kind: 'next_game', at: Math.max(st.roundEndsAt, now + st.rules.nextGameSeconds * 1000) } : null;
}

/** After a game: the final settlement when called off, the Placecut when the 20 minutes are up, otherwise the next game. */
export function nextGame(st: State, now: number): GameEvent[] {
  if (st.phase !== 'game_over') fail('not_over', 'The game is still being played.');
  if (st.callOff) return endSession(st, now);
  if (placecutDue(st, now)) return enterPlacecut(st, now);
  return startNext(st, now);
}

function buildScorecard(st: State, now: number, kind: Scorecard['kind']): Scorecard {
  const rows = st.players.map((p) => rowFor(st, p, false));
  const last = st.history.at(-1);
  return {
    kind, round: st.game, period: st.round, at: now, final: kind === 'final', games: st.game,
    results: kind === 'game' && last && last.game === st.game ? [last] : [],
    totalPot: st.totalPot, totalBonus: st.totalBonus, wellCuts: st.wellCutCount, loansIssued: st.bankLoansTotal,
    loans: st.p2p.map((l) => ({ ...l })), loanLog: kind === 'game' ? [] : [...st.p2pLog],
    rows: [...rows, ...(kind === 'final' ? st.departed : [])],
  };
}

function saveCard(st: State, card: Scorecard) {
  st.scorecards.push(card);
  if (st.scorecards.length > CARDS_TAIL) st.scorecards.splice(0, st.scorecards.length - CARDS_TAIL);
  st.cardOutbox.push(card);
}

/** §14 Placecut: settlement scorecards for everyone, join/leave, then the admin starts the next 20 minutes. */
function enterPlacecut(st: State, now: number): GameEvent[] {
  st.phase = 'placecut';
  st.turn = -1;
  st.deadline = null;
  st.roundEndsAt = null;
  saveCard(st, buildScorecard(st, now, 'placecut'));
  st.players.forEach((p, i) => tx(st, now, i, 'placecut', 0, `Placecut ${st.round}: balance ${p.coins}, bank loan ${p.loan}, owes players ${owesPlayers(st, p.uid)}, owed ${owedByPlayers(st, p.uid)}`));
  return [{ e: 'placecut', round: st.round }];
}

function endSession(st: State, now: number): GameEvent[] {
  if (st.game > 0) saveCard(st, buildScorecard(st, now, 'final'));
  st.phase = 'ended';
  st.deadline = null;
  st.turn = -1;
  st.requests = [];
  return [{ e: 'ended' }];
}

/** Only the admin calls off the tournament; a game in progress finishes first. */
export function callOff(st: State, uid: string, now: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can call off the tournament.');
  if (st.phase === 'ended') return [];
  tx(st, now, seatOf(st, uid), 'admin', 0, 'Tournament called off');
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
      // Only the final settlement or the Placecut start on their own; the admin starts ordinary next games.
      if (st.phase !== 'game_over') return [];
      if (st.callOff) return endSession(st, now);
      if (placecutDue(st, now)) return enterPlacecut(st, now);
      st.deadline = null;
      return [];
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
  lastCut: CutInfo | null;
  /** The timing bar while the dealer cuts: every phone draws the same slider from this. */
  cutBar: CutBar | null;
  rules: { blind: number; seen: number; sideshow: number; maxLoan: number; startingCoins: number; extraBlinds: number; turnSeconds: number; wellCutZone: number };
  players: {
    name: string; coins: number; loan: number; status: PlayerStatus; seen: boolean; connected: boolean;
    /** A computer player. */
    bot: boolean;
    cardCount: number; cards: string[] | null; isAdmin: boolean; isDealer: boolean;
    /** Extra Blind actions left (§9), when this player is the only Blind one left. */
    extraBlindsLeft: number | null;
    /** Owed to other players / owed by other players (player loans). */
    owes: number;
    owed: number;
  }[];
  /** Outstanding player loans (everyone can see who owes whom). */
  p2p: P2PLoan[];
  /** My open request (as borrower) and requests waiting for my answer (as lender). */
  myRequest: { id: number; to: number; amount: number } | null;
  incoming: { id: number; from: number; amount: number }[];
  /** Recent games of the tournament. */
  history: GameRecord[];
  /** Seat of the player whose Blind bet forces the next player to play Seen. */
  lastBlind: number | null;
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
    /** Final lending rule: may ask another player for a loan. */
    borrow: boolean;
    /** The player before you played Blind: you must play Seen (2 coins) or pack. */
    mustSeen: boolean;
    startGame: boolean; callOff: boolean; leave: boolean; tableSize: boolean;
    /** After a game: the 20 minutes are up, so the admin's button opens the Placecut. */
    placecutDue: boolean;
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
  const forced = myTurn && mustPlaySeen(st, me);
  const myReq = mine ? st.requests.find((r) => r.from === mine.uid) : undefined;
  const lastCard = st.scorecards.at(-1) ?? null;
  return {
    phase: st.phase, you: me, isAdmin, round: st.round, roundEndsAt: st.roundEndsAt, callOff: st.callOff, timerOn: st.timerOn,
    tableSize: st.tableSize, minPlayers: st.rules.minPlayers, maxPlayers: st.rules.maxPlayers,
    game: st.game, roundGames: st.roundGames, dealer: d, cutter: cutterSeat(st), turn: st.turn, pot: st.pot, cardsEach: st.cardsEach,
    wellCut: { active: st.wellCut.active, game: wellCutGameNo(st), sequence: st.rules.wellCutSequence },
    wellCutCount: st.wellCutCount,
    lastCut: st.phase === 'cutting' ? null : st.lastCut,
    cutBar: st.phase === 'cutting' ? st.cutBar : null,
    rules: { blind: st.rules.blindCost, seen: st.rules.seenCost, sideshow: st.rules.sideshowCost, maxLoan: st.rules.maxLoan, startingCoins: st.rules.startingCoins, extraBlinds: st.rules.extraBlindActions, turnSeconds: st.rules.turnSeconds, wellCutZone: st.rules.wellCutZone },
    players: st.players.map((p, i) => ({
      name: p.name, coins: p.coins, loan: p.loan, status: p.status, seen: p.seen, connected: p.connected, bot: isBotUid(p.uid),
      cardCount: p.cards.length, cards: i === me || shown.includes(i) ? p.cards.map(cardCode) : null,
      isAdmin: p.uid === st.adminUid, isDealer: i === d,
      extraBlindsLeft: st.phase === 'betting' && onlyBlindLeft(st, i) ? Math.max(0, st.rules.extraBlindActions - p.extraBlinds) : null,
      owes: owesPlayers(st, p.uid), owed: owedByPlayers(st, p.uid),
    })),
    p2p: st.p2p,
    myRequest: myReq ? { id: myReq.id, to: seatOf(st, myReq.to), amount: myReq.amount } : null,
    incoming: mine ? st.requests.filter((r) => r.to === mine.uid).map((r) => ({ id: r.id, from: seatOf(st, r.from), amount: r.amount })) : [],
    history: st.history.slice(-30),
    lastBlind: st.phase === 'betting' && st.lastBet?.kind === 'blind' ? st.lastBet.seat : null,
    commit: st.commit,
    result: over ? st.result : null,
    deadline: st.deadline,
    scorecard: st.phase === 'placecut' || st.phase === 'ended' || st.phase === 'game_over' ? lastCard : null,
    ledger: st.ledger.slice(-80),
    yourHand: mine && mine.seen && mine.cards.length ? evaluate(mine.cards).name : null,
    options: {
      see: st.phase === 'betting' && mine?.status === 'in' && !mine.seen,
      blind: myTurn && !mine!.seen && !forced,
      seen: myTurn && (mine!.seen || forced),
      pack: myTurn,
      show,
      sideshow,
      cut: st.phase === 'cutting' && me >= 0 && me === cutterSeat(st),
      deal: st.phase === 'dealing' && mine?.uid === st.dealerUid,
      loan: mine && st.phase !== 'ended' && loanLeft(st, me) > 0 ? { left: loanLeft(st, me), needed } : null,
      borrow: !!mine && st.phase !== 'ended' && canBorrowFromPlayers(st, me),
      mustSeen: forced,
      startGame: isAdmin && ((between && st.players.filter((_, i) => canPlay(st, i)).length >= st.rules.minPlayers) || (st.phase === 'game_over' && !st.callOff)),
      placecutDue: st.phase === 'game_over' && placecutDue(st, Date.now()),
      callOff: isAdmin && st.phase !== 'ended' && !st.callOff,
      leave: !!mine && !isAdmin && (atBoundary(st) || st.phase === 'ended'),
      tableSize: isAdmin && atBoundary(st),
    },
  };
}

/** Full session report for the PDF (admin). */
export function sessionReport(st: State) {
  return {
    createdAt: st.createdAt, rounds: st.round, games: st.game, wellCuts: st.wellCutCount,
    totalPot: st.totalPot, totalBonus: st.totalBonus, bankLoans: st.bankLoansTotal, loans: st.p2p, loanLog: st.p2pLog,
    scorecards: st.scorecards,
    players: st.players.map((p) => rowFor(st, p, false)),
    departed: st.departed,
  };
}
