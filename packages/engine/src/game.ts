/**
 * DANKA CLUB game state machine.
 *
 * Pure logic, no I/O: the room server owns one GameState per room, passes in
 * the time and the shuffled deck, and broadcasts the returned events.
 * Functions mutate the state they are given and return the events produced.
 * Invalid moves throw GameError and leave the state unchanged.
 */
import { type Card, cardCode, deckString } from './cards';
import { type HandContext, type HandMode, type HandValue, bestHand, compareHands } from './hands';
import { type HouseRules, type SessionMode, HAND_MODES, MAX_SEATS, MODE_NAMES, SESSION_MODES, tournamentBoot } from './rules';

export type Phase = 'waiting' | 'picking' | 'dealing' | 'betting' | 'hand_over' | 'session_over' | 'closed';
export type SeatStatus = 'in' | 'packed' | 'out';

export interface Seat {
  uid: string;
  name: string;
  coins: number;
  /** Total coins borrowed from the bank this session. */
  loan: number;
  /** Knocked out of a tournament. */
  out: boolean;
  status: SeatStatus;
  seen: boolean;
  cards: Card[];
  ready: boolean;
  connected: boolean;
  blindTurns: number;
  /** Coins put into the current pot. */
  contributed: number;
}

export type Action = { type: 'see' } | { type: 'pack' } | { type: 'chaal' } | { type: 'raise' } | { type: 'show' };

export type GameEvent =
  | { e: 'joined'; seat: number; name: string; rejoined: boolean }
  | { e: 'left'; seat: number; name: string }
  | { e: 'ready'; seat: number; ready: boolean }
  | { e: 'session_mode'; mode: SessionMode }
  | { e: 'started' }
  | { e: 'hand'; hand: number; boot: number }
  | { e: 'picking'; dealer: number }
  | { e: 'mode'; mode: HandMode; by: number | null }
  | { e: 'loan'; seat: number; amount: number }
  | { e: 'boot'; seats: number[]; amount: number }
  | { e: 'commit'; hash: string }
  | { e: 'wild'; rank: number }
  | { e: 'deal'; dealer: number; order: number[]; cardsEach: number; auto: boolean }
  | { e: 'turn'; seat: number; deadline: number }
  | { e: 'see'; seat: number }
  | { e: 'bet'; seat: number; amount: number; kind: 'blind' | 'chaal' | 'raise' | 'show'; stake: number }
  | { e: 'pack'; seat: number; reason: 'choice' | 'timeout' }
  | { e: 'show'; requester: number; opponent: number; winner: number }
  | { e: 'win'; seat: number; pot: number; reason: 'all_packed' | 'show' }
  | { e: 'out'; seat: number }
  | { e: 'champion'; seat: number }
  | { e: 'closed' };

export interface Deadline {
  kind: 'turn' | 'deal' | 'pick' | 'next_hand';
  at: number;
}

export interface ShowInfo {
  requester: number;
  opponent: number;
  requesterCards: string[];
  opponentCards: string[];
  requesterHand: HandValue;
  opponentHand: HandValue;
}

export interface HandResult {
  hand: number;
  winner: number;
  pot: number;
  reason: 'all_packed' | 'show';
  show: ShowInfo | null;
  /** Fairness proof, revealed only after the hand. */
  commit: string;
  deck: string;
  salt: string;
}

export interface LedgerEntry {
  at: number;
  hand: number;
  kind: 'info' | 'boot' | 'loan' | 'see' | 'bet' | 'pack' | 'show' | 'win' | 'mode' | 'out';
  text: string;
  seat?: number;
  amount?: number;
}

export interface GameState {
  v: 1;
  rules: HouseRules;
  sessionMode: SessionMode;
  phase: Phase;
  createdAt: number;
  adminUid: string;
  seats: Seat[];
  hand: number;
  handMode: HandMode;
  wild: number;
  dealer: number;
  turn: number;
  boot: number;
  stake: number;
  pot: number;
  actionsThisHand: number;
  commit: string | null;
  /** Server-only: never sent to phones before the hand ends. */
  secret: { deck: string; salt: string } | null;
  result: HandResult | null;
  champion: number | null;
  deadline: Deadline | null;
  ledger: LedgerEntry[];
}

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const LEDGER_MAX = 600;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const fail = (code: string, message: string): never => {
  throw new GameError(code, message);
};

export const seatOf = (st: GameState, uid: string): number => st.seats.findIndex((s) => s.uid === uid);

const requireSeat = (st: GameState, uid: string): number => {
  const i = seatOf(st, uid);
  if (i < 0) fail('not_seated', 'You are not seated in this room.');
  return i;
};

export const activeSeats = (st: GameState): number[] => st.seats.flatMap((s, i) => (s.status === 'in' ? [i] : []));

export function nextActive(st: GameState, from: number): number {
  const n = st.seats.length;
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n;
    if (st.seats[j].status === 'in') return j;
  }
  return -1;
}

export const stakeCap = (st: GameState): number => st.boot * st.rules.stakeCapMultiple;
export const costFor = (st: GameState, i: number): number => (st.seats[i].seen ? st.stake * st.rules.seenMultiplier : st.stake);
export const handContext = (st: GameState): HandContext => ({ mode: st.handMode, wild: st.wild || undefined });
const nameOf = (st: GameState, i: number): string => st.seats[i].name;

function log(st: GameState, now: number, entry: Omit<LedgerEntry, 'at' | 'hand'>): void {
  st.ledger.push({ at: now, hand: st.hand, ...entry });
  if (st.ledger.length > LEDGER_MAX) st.ledger.splice(0, st.ledger.length - LEDGER_MAX);
}

function takeLoan(st: GameState, i: number, now: number, ev: GameEvent[]): void {
  const s = st.seats[i];
  const amount = st.rules.loanAmount;
  s.coins += amount;
  s.loan += amount;
  ev.push({ e: 'loan', seat: i, amount });
  log(st, now, { kind: 'loan', seat: i, amount, text: `${s.name} took a ${amount}-coin loan from the bank` });
}

/** Moves coins from a seat into the pot. Tournament players go all-in instead of borrowing. Returns the amount paid. */
function pay(st: GameState, i: number, amount: number, now: number, ev: GameEvent[]): number {
  const s = st.seats[i];
  if (st.sessionMode === 'tour' || !st.rules.loansAllowed) amount = Math.min(amount, s.coins);
  else while (s.coins < amount) takeLoan(st, i, now, ev);
  s.coins -= amount;
  s.contributed += amount;
  st.pot += amount;
  return amount;
}

function setTurn(st: GameState, i: number, now: number, ev: GameEvent[]): void {
  st.turn = i;
  st.deadline = { kind: 'turn', at: now + st.rules.turnSeconds * 1000 };
  ev.push({ e: 'turn', seat: i, deadline: st.deadline.at });
}

/* ------------------------------------------------------------------ */
/* room lifecycle                                                      */
/* ------------------------------------------------------------------ */

export function createGame(opts: { rules: HouseRules; sessionMode: SessionMode; admin: { uid: string; name: string }; now: number }): GameState {
  if (!SESSION_MODES.includes(opts.sessionMode)) fail('bad_mode', 'Unknown game mode.');
  const st: GameState = {
    v: 1,
    rules: { ...opts.rules },
    sessionMode: opts.sessionMode,
    phase: 'waiting',
    createdAt: opts.now,
    adminUid: opts.admin.uid,
    seats: [],
    hand: 0,
    handMode: 'classic',
    wild: 0,
    dealer: 0,
    turn: -1,
    boot: opts.rules.boot,
    stake: opts.rules.boot,
    pot: 0,
    actionsThisHand: 0,
    commit: null,
    secret: null,
    result: null,
    champion: null,
    deadline: null,
    ledger: [],
  };
  join(st, opts.admin.uid, opts.admin.name, opts.now);
  return st;
}

/** Seats a player, or returns them to their own seat when reconnecting. Entry order is seat order. */
export function join(st: GameState, uid: string, name: string, now: number): { seat: number; events: GameEvent[] } {
  const existing = seatOf(st, uid);
  if (existing >= 0) {
    st.seats[existing].connected = true;
    return { seat: existing, events: [{ e: 'joined', seat: existing, name: st.seats[existing].name, rejoined: true }] };
  }
  if (st.phase === 'closed' || st.phase === 'session_over') fail('room_closed', 'This room has been closed.');
  if (st.seats.length >= MAX_SEATS) fail('room_full', 'This room is full (7/7).');
  const started = st.phase !== 'waiting';
  if (started && (!st.rules.lateJoin || st.sessionMode === 'tour')) fail('game_started', 'This game has already started.');
  const clean = name.trim().slice(0, 24) || `Player ${st.seats.length + 1}`;
  // A late joiner is dealt in if the cards are not locked yet; otherwise they sit out until the next hand begins.
  const dealtIn = !started || st.phase === 'picking' || (st.phase === 'dealing' && st.commit === null);
  st.seats.push({ uid, name: clean, coins: started ? st.rules.startingCoins : 0, loan: 0, out: false, status: dealtIn ? 'in' : 'packed', seen: false, cards: [], ready: started, connected: true, blindTurns: 0, contributed: 0 });
  const seat = st.seats.length - 1;
  log(st, now, { kind: 'info', seat, text: started ? `${clean} joined the game as seat #${seat + 1} and plays from the next hand` : `${clean} joined as seat #${seat + 1}${seat === 0 ? ' and deals game 1' : ''}` });
  return { seat, events: [{ e: 'joined', seat, name: clean, rejoined: false }] };
}

export function leave(st: GameState, uid: string, now: number): GameEvent[] {
  const i = requireSeat(st, uid);
  if (st.phase !== 'waiting') fail('game_started', 'You can only leave before the game starts.');
  if (uid === st.adminUid) fail('admin_cannot_leave', 'The admin closes the room instead of leaving.');
  const [s] = st.seats.splice(i, 1);
  log(st, now, { kind: 'info', text: `${s.name} left the waiting room` });
  return [{ e: 'left', seat: i, name: s.name }];
}

export function setConnected(st: GameState, uid: string, connected: boolean): void {
  const i = seatOf(st, uid);
  if (i >= 0) st.seats[i].connected = connected;
}

export function setReady(st: GameState, uid: string, ready: boolean): GameEvent[] {
  const i = requireSeat(st, uid);
  if (st.phase !== 'waiting') fail('game_started', 'The game has already started.');
  st.seats[i].ready = ready;
  return [{ e: 'ready', seat: i, ready }];
}

export function setSessionMode(st: GameState, uid: string, mode: SessionMode): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can change the game mode.');
  if (st.phase !== 'waiting') fail('game_started', 'The mode is locked once the game starts.');
  if (!SESSION_MODES.includes(mode)) fail('bad_mode', 'Unknown game mode.');
  st.sessionMode = mode;
  return [{ e: 'session_mode', mode }];
}

export function start(st: GameState, uid: string, now: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can start the game.');
  if (st.phase !== 'waiting') fail('game_started', 'The game has already started.');
  if (st.seats.length < st.rules.minPlayers) fail('not_enough_players', `At least ${st.rules.minPlayers} players are needed to start.`);
  if (!st.seats.every((s) => s.ready)) fail('not_ready', 'Every player must be ready.');
  for (const s of st.seats) s.coins = st.rules.startingCoins;
  st.dealer = 0; // first to enter deals game 1; the admin cannot change this
  log(st, now, { kind: 'info', text: `Game started: ${MODE_NAMES[st.sessionMode]}` });
  return [{ e: 'started' }, ...beginHand(st, now)];
}

/** Admin closes the room between hands. */
export function close(st: GameState, uid: string, now: number): GameEvent[] {
  if (uid !== st.adminUid) fail('not_admin', 'Only the admin can close the room.');
  if (st.phase === 'picking' || st.phase === 'dealing' || st.phase === 'betting') fail('hand_in_progress', 'Close the room between hands.');
  st.phase = 'closed';
  st.deadline = null;
  log(st, now, { kind: 'info', text: 'The admin closed the room' });
  return [{ e: 'closed' }];
}

/* ------------------------------------------------------------------ */
/* hands                                                               */
/* ------------------------------------------------------------------ */

export function beginHand(st: GameState, now: number): GameEvent[] {
  const ev: GameEvent[] = [];
  const tour = st.sessionMode === 'tour';
  st.hand += 1;
  st.result = null;
  st.commit = null;
  st.secret = null;
  st.wild = 0;
  st.actionsThisHand = 0;
  st.turn = -1;
  st.boot = tour ? tournamentBoot(st.rules, st.hand) : st.rules.boot;

  if (tour) {
    st.seats.forEach((s, i) => {
      if (!s.out && s.coins < st.boot) {
        s.out = true;
        ev.push({ e: 'out', seat: i });
        log(st, now, { kind: 'out', seat: i, text: `${s.name} is out of the tournament` });
      }
    });
    const alive = st.seats.flatMap((s, i) => (s.out ? [] : [i]));
    if (alive.length <= 1) {
      st.champion = alive[0] ?? null;
      st.phase = 'session_over';
      st.deadline = null;
      if (st.champion !== null) {
        ev.push({ e: 'champion', seat: st.champion });
        log(st, now, { kind: 'win', seat: st.champion, text: `${nameOf(st, st.champion)} won Tournament Night after ${st.hand - 1} hands` });
      }
      return ev;
    }
    while (st.seats[st.dealer].out) st.dealer = (st.dealer + 1) % st.seats.length;
  } else if (st.rules.loansAllowed) {
    st.seats.forEach((s, i) => {
      if (s.coins < st.boot * st.rules.loanBelowBootMultiple) takeLoan(st, i, now, ev);
    });
  }

  for (const s of st.seats) {
    s.status = s.out ? 'out' : 'in';
    s.seen = false;
    s.cards = [];
    s.blindTurns = 0;
    s.contributed = 0;
  }
  st.stake = st.boot;
  st.pot = 0;
  ev.unshift({ e: 'hand', hand: st.hand, boot: st.boot });

  if (st.sessionMode === 'dealers') {
    st.phase = 'picking';
    st.handMode = 'classic';
    st.deadline = { kind: 'pick', at: now + st.rules.pickSeconds * 1000 };
    ev.push({ e: 'picking', dealer: st.dealer });
  } else {
    st.handMode = tour ? 'classic' : (st.sessionMode as HandMode);
    st.phase = 'dealing';
    st.deadline = null; // the server shuffles next and calls prepareDeal
    ev.push({ e: 'mode', mode: st.handMode, by: null });
  }
  return ev;
}

/** Dealer's Choice: the dealer picks this hand's game. Pass uid null for the automatic pick when time runs out. */
export function pickMode(st: GameState, uid: string | null, mode: HandMode, now: number): GameEvent[] {
  if (st.phase !== 'picking') fail('not_picking', 'There is no game to pick right now.');
  if (uid !== null && seatOf(st, uid) !== st.dealer) fail('not_dealer', 'Only the dealer picks the game.');
  if (!HAND_MODES.includes(mode)) fail('bad_mode', 'Unknown game.');
  st.handMode = mode;
  st.phase = 'dealing';
  st.deadline = null;
  log(st, now, { kind: 'mode', seat: st.dealer, text: `${nameOf(st, st.dealer)} picked ${MODE_NAMES[mode]}${uid === null ? ' (time ran out)' : ''}` });
  return [{ e: 'mode', mode, by: st.dealer }];
}

/** True when the server must shuffle and call prepareDeal. */
export const needsDeck = (st: GameState): boolean => st.phase === 'dealing' && st.commit === null;

/**
 * Collects the boot, locks cards to seats and records the fairness fingerprint.
 * `deck` must be freshly shuffled by the server; `commit` = sha256(commitmentInput(deckString(deck), salt)).
 */
export function prepareDeal(st: GameState, deck: Card[], salt: string, commit: string, now: number): GameEvent[] {
  if (!needsDeck(st)) fail('not_dealing', 'The deck is not needed right now.');
  if (deck.length !== 52) fail('bad_deck', 'A full 52-card deck is required.');
  const ev: GameEvent[] = [];
  const active = activeSeats(st);
  for (const i of active) pay(st, i, st.boot, now, ev);
  ev.push({ e: 'boot', seats: active, amount: st.boot });
  log(st, now, { kind: 'boot', amount: st.boot, text: `Hand ${st.hand} (${MODE_NAMES[st.handMode]}): boot ${st.boot} from ${active.length} players, pot ${st.pot}` });

  const cardsEach = st.handMode === 'four' ? 4 : st.rules.cardsPerPlayer;
  const order = dealOrder(st);
  let k = 0;
  for (let round = 0; round < cardsEach; round++) for (const i of order) st.seats[i].cards.push(deck[k++]);

  if (st.handMode === 'joker') {
    st.wild = deck[51].r; // drawn from the bottom of the deck, never dealt
    ev.push({ e: 'wild', rank: st.wild });
    log(st, now, { kind: 'mode', text: `Wild rank drawn: ${cardCode(deck[51]).slice(0, -1)}` });
  }
  st.commit = commit;
  st.secret = { deck: deckString(deck), salt };
  st.deadline = { kind: 'deal', at: now + st.rules.autoDealSeconds * 1000 };
  ev.push({ e: 'commit', hash: commit });
  return ev;
}

/** Clockwise from the dealer's left, skipping players who are out. */
export function dealOrder(st: GameState): number[] {
  const n = st.seats.length;
  const order: number[] = [];
  for (let k = 1; k <= n; k++) {
    const j = (st.dealer + k) % n;
    if (st.seats[j].status === 'in') order.push(j);
  }
  return order;
}

/** The dealer's deal is ceremonial: cards were locked to seats in prepareDeal. Pass uid null for the automatic deal. */
export function deal(st: GameState, uid: string | null, now: number): GameEvent[] {
  if (st.phase !== 'dealing' || st.commit === null) fail('not_dealing', 'Nothing to deal right now.');
  if (uid !== null && seatOf(st, uid) !== st.dealer) fail('not_dealer', 'Only the dealer deals.');
  const ev: GameEvent[] = [{ e: 'deal', dealer: st.dealer, order: dealOrder(st), cardsEach: st.seats[st.dealer].cards.length || st.seats[dealOrder(st)[0]].cards.length, auto: uid === null }];
  st.phase = 'betting';
  setTurn(st, nextActive(st, st.dealer), now, ev);
  return ev;
}

export function act(st: GameState, uid: string, action: Action, now: number): GameEvent[] {
  if (st.phase !== 'betting') fail('not_betting', 'No betting is happening right now.');
  const i = requireSeat(st, uid);
  const s = st.seats[i];
  if (s.status !== 'in') fail('not_in_hand', 'You are not in this hand.');
  const ev: GameEvent[] = [];

  if (action.type === 'see') {
    if (s.seen) fail('already_seen', 'You have already seen your cards.');
    s.seen = true;
    log(st, now, { kind: 'see', seat: i, text: `${s.name} saw their cards` });
    return [{ e: 'see', seat: i }];
  }

  if (st.turn !== i) fail('not_your_turn', 'It is not your turn.');
  const max = st.rules.maxBlindTurns;
  if (!s.seen && max !== null && s.blindTurns >= max && (action.type === 'chaal' || action.type === 'raise'))
    fail('must_see', `After ${max} blind turns you must see your cards.`);

  switch (action.type) {
    case 'pack':
      packSeat(st, i, 'choice', now, ev);
      break;
    case 'chaal': {
      const kind = s.seen ? 'chaal' : 'blind';
      const paid = pay(st, i, costFor(st, i), now, ev);
      if (!s.seen) s.blindTurns++;
      ev.push({ e: 'bet', seat: i, amount: paid, kind, stake: st.stake });
      log(st, now, { kind: 'bet', seat: i, amount: paid, text: `${s.name} ${kind} ${paid}, pot ${st.pot}` });
      break;
    }
    case 'raise': {
      if (st.stake >= stakeCap(st)) fail('at_cap', 'The stake is already at its limit.');
      st.stake = Math.min(st.stake * 2, stakeCap(st));
      const paid = pay(st, i, costFor(st, i), now, ev);
      if (!s.seen) s.blindTurns++;
      ev.push({ e: 'bet', seat: i, amount: paid, kind: 'raise', stake: st.stake });
      log(st, now, { kind: 'bet', seat: i, amount: paid, text: `${s.name} raised: ${paid}, pot ${st.pot}` });
      break;
    }
    case 'show': {
      const active = activeSeats(st);
      if (st.rules.showOnlyWithTwo && active.length !== 2) fail('show_not_allowed', 'A Show is only allowed when two players remain.');
      const paid = pay(st, i, costFor(st, i), now, ev);
      ev.push({ e: 'bet', seat: i, amount: paid, kind: 'show', stake: st.stake });
      log(st, now, { kind: 'show', seat: i, amount: paid, text: `${s.name} asked for a Show (${paid})` });
      resolveShow(st, i, now, ev);
      return ev;
    }
    default:
      fail('bad_action', 'Unknown action.');
  }

  st.actionsThisHand++;
  advance(st, i, now, ev);
  return ev;
}

function packSeat(st: GameState, i: number, reason: 'choice' | 'timeout', now: number, ev: GameEvent[]): void {
  st.seats[i].status = 'packed';
  ev.push({ e: 'pack', seat: i, reason });
  log(st, now, { kind: 'pack', seat: i, text: `${nameOf(st, i)} packed${reason === 'timeout' ? ' (time ran out)' : ''}` });
}

function advance(st: GameState, from: number, now: number, ev: GameEvent[]): void {
  const active = activeSeats(st);
  if (active.length === 1) {
    finishHand(st, active[0], 'all_packed', null, now, ev);
    return;
  }
  setTurn(st, nextActive(st, from), now, ev);
}

function resolveShow(st: GameState, requester: number, now: number, ev: GameEvent[]): void {
  const opponent = activeSeats(st).find((j) => j !== requester)!;
  const ctx = handContext(st);
  const rh = bestHand(st.seats[requester].cards, ctx);
  const oh = bestHand(st.seats[opponent].cards, ctx);
  // Equal hands: the player who asked for the Show loses (stand-in, open question Q6).
  const winner = compareHands(rh, oh, ctx) > 0 ? requester : opponent;
  const loser = winner === requester ? opponent : requester;
  st.seats[requester].seen = true;
  st.seats[opponent].seen = true;
  st.seats[loser].status = 'packed';
  ev.push({ e: 'show', requester, opponent, winner });
  log(st, now, { kind: 'show', seat: winner, text: `Show: ${nameOf(st, requester)} (${rh.name}) vs ${nameOf(st, opponent)} (${oh.name})` });
  const show: ShowInfo = {
    requester,
    opponent,
    requesterCards: st.seats[requester].cards.map(cardCode),
    opponentCards: st.seats[opponent].cards.map(cardCode),
    requesterHand: rh,
    opponentHand: oh,
  };
  finishHand(st, winner, 'show', show, now, ev);
}

function finishHand(st: GameState, winner: number, reason: 'all_packed' | 'show', show: ShowInfo | null, now: number, ev: GameEvent[]): void {
  const pot = st.pot;
  st.seats[winner].coins += pot;
  st.pot = 0;
  st.result = { hand: st.hand, winner, pot, reason, show, commit: st.commit!, deck: st.secret!.deck, salt: st.secret!.salt };
  st.dealer = winner; // the winner deals the next hand
  st.turn = -1;
  st.phase = 'hand_over';
  st.deadline = { kind: 'next_hand', at: now + st.rules.nextHandSeconds * 1000 };
  ev.push({ e: 'win', seat: winner, pot, reason });
  log(st, now, { kind: 'win', seat: winner, amount: pot, text: `${nameOf(st, winner)} won ${pot}${reason === 'all_packed' ? ' (everyone else packed)' : ' at the Show'} and deals next` });
}

/** Any player may move straight to the next hand once a hand is over. */
export function nextHand(st: GameState, now: number): GameEvent[] {
  if (st.phase !== 'hand_over') fail('not_hand_over', 'The hand is still going.');
  return beginHand(st, now);
}

/** Runs whatever is due when the deadline passes: auto-pack, auto-deal, auto-pick or next hand. */
export function onDeadline(st: GameState, now: number): GameEvent[] {
  const d = st.deadline;
  if (!d || now < d.at) return [];
  switch (d.kind) {
    case 'turn': {
      if (st.phase !== 'betting') return [];
      const ev: GameEvent[] = [];
      const i = st.turn;
      packSeat(st, i, 'timeout', now, ev);
      st.actionsThisHand++;
      advance(st, i, now, ev);
      return ev;
    }
    case 'deal':
      return st.phase === 'dealing' && st.commit ? deal(st, null, now) : [];
    case 'pick':
      return st.phase === 'picking' ? pickMode(st, null, 'classic', now) : [];
    case 'next_hand':
      return st.phase === 'hand_over' ? beginHand(st, now) : [];
  }
}

/* ------------------------------------------------------------------ */
/* what each phone is allowed to see                                   */
/* ------------------------------------------------------------------ */

export interface SeatView {
  name: string;
  coins: number;
  loan: number;
  status: SeatStatus;
  seen: boolean;
  ready: boolean;
  connected: boolean;
  cardCount: number;
  /** Only your own cards, plus both hands after a Show. */
  cards: string[] | null;
  isAdmin: boolean;
}

export interface PlayerView {
  phase: Phase;
  you: number;
  hand: number;
  sessionMode: SessionMode;
  handMode: HandMode;
  modeName: string;
  wild: number;
  dealer: number;
  turn: number;
  boot: number;
  stake: number;
  cap: number;
  pot: number;
  /** A Seen player stakes this multiple of the blind stake. */
  seenMultiplier: number;
  turnSeconds: number;
  minPlayers: number;
  maxSeats: number;
  /** You joined during a hand and are dealt in from the next one. */
  waitingForNextHand: boolean;
  seats: SeatView[];
  commit: string | null;
  result: HandResult | null;
  champion: number | null;
  deadline: Deadline | null;
  /** Your options right now, so the app never has to recompute rules. */
  options: { see: boolean; pack: boolean; chaal: number | null; raise: number | null; show: number | null; deal: boolean; pick: boolean; start: boolean; next: boolean };
  /** Name of your best hand once you have seen your cards. */
  yourHand: string | null;
  ledger: LedgerEntry[];
}

export function viewFor(st: GameState, uid: string, ledgerTail = 60): PlayerView {
  const me = seatOf(st, uid);
  const over = st.phase === 'hand_over' || st.phase === 'session_over';
  const shown = over && st.result?.show ? [st.result.show.requester, st.result.show.opponent] : [];
  const seats: SeatView[] = st.seats.map((s, i) => ({
    name: s.name,
    coins: s.coins,
    loan: s.loan,
    status: s.status,
    seen: s.seen,
    ready: s.ready,
    connected: s.connected,
    cardCount: s.cards.length,
    cards: i === me || shown.includes(i) ? s.cards.map(cardCode) : null,
    isAdmin: s.uid === st.adminUid,
  }));
  const mine = me >= 0 ? st.seats[me] : null;
  const myTurn = st.phase === 'betting' && st.turn === me && mine?.status === 'in';
  const canRaise = myTurn && st.stake < stakeCap(st);
  const raiseCost = canRaise ? Math.min(st.stake * 2, stakeCap(st)) * (mine!.seen ? st.rules.seenMultiplier : 1) : null;
  const twoLeft = activeSeats(st).length === 2;
  return {
    phase: st.phase,
    you: me,
    hand: st.hand,
    sessionMode: st.sessionMode,
    handMode: st.handMode,
    modeName: MODE_NAMES[st.sessionMode === 'tour' ? 'tour' : st.handMode],
    wild: st.wild,
    dealer: st.dealer,
    turn: st.turn,
    boot: st.boot,
    stake: st.stake,
    cap: stakeCap(st),
    pot: st.pot,
    seenMultiplier: st.rules.seenMultiplier,
    turnSeconds: st.rules.turnSeconds,
    minPlayers: st.rules.minPlayers,
    maxSeats: MAX_SEATS,
    waitingForNextHand: !!mine && !mine.out && mine.cards.length === 0 && (st.phase === 'betting' || st.phase === 'hand_over' || (st.phase === 'dealing' && st.commit !== null)),
    seats,
    commit: st.commit,
    result: over ? st.result : null,
    champion: st.champion,
    deadline: st.deadline,
    options: {
      see: st.phase === 'betting' && mine?.status === 'in' && !mine.seen,
      pack: myTurn,
      chaal: myTurn ? costFor(st, me) : null,
      raise: raiseCost,
      show: myTurn && (twoLeft || !st.rules.showOnlyWithTwo) ? costFor(st, me) : null,
      deal: st.phase === 'dealing' && st.commit !== null && me === st.dealer,
      pick: st.phase === 'picking' && me === st.dealer,
      start: st.phase === 'waiting' && uid === st.adminUid && st.seats.length >= st.rules.minPlayers && st.seats.every((s) => s.ready),
      next: st.phase === 'hand_over',
    },
    yourHand: mine && mine.seen && mine.cards.length ? bestHand(mine.cards, handContext(st)).name : null,
    ledger: st.ledger.slice(-ledgerTail),
  };
}

/** Coins and loans per player, best first. Coins have no cash value. */
export function standings(st: GameState): { seat: number; name: string; coins: number; loan: number; net: number }[] {
  return st.seats
    .map((s, i) => ({ seat: i, name: s.name, coins: s.coins, loan: s.loan, net: s.coins - s.loan - st.rules.startingCoins }))
    .sort((a, b) => b.net - a.net);
}
