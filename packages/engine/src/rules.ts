import type { HandMode } from './hands';

/**
 * House rules. Every field maps to an open question in the spec (Q1–Q12).
 * STAND_IN_RULES below are standard Teen Patti values so the game is playable;
 * replace them with the group's signed-off answers. Nothing else in the code
 * should hard-code a rule.
 */
export interface HouseRules {
  /** Q5 Coins every player puts in before the deal. Also the opening blind stake. */
  boot: number;
  /** Q5 A Seen player stakes this multiple of the current blind stake. */
  seenMultiplier: number;
  /** Q5 Highest blind stake allowed, as a multiple of the boot. */
  stakeCapMultiple: number;
  /** Q5 Maximum consecutive blind turns per player; null = unlimited. */
  maxBlindTurns: number | null;
  /** Q1 Cards per player in Classic. (The spec's "random card count" is still undefined.) */
  cardsPerPlayer: 3;
  /** Q6 Show is only allowed when exactly two players remain. */
  showOnlyWithTwo: boolean;
  /** Q6 Who wins a Show between equal hands. */
  showTie: 'requester_loses';
  /** Q8 Coins each player starts the session with. */
  startingCoins: number;
  /** Q9 Whether the bank lends coins, how much per loan, and when a loan is given automatically. */
  loansAllowed: boolean;
  loanAmount: number;
  /** A loan is added at the start of a hand when coins fall below boot × this. */
  loanBelowBootMultiple: number;
  /** Q10 Seconds per turn before the player packs automatically. */
  turnSeconds: number;
  /** Seconds the dealer has to start the deal before it happens automatically. */
  autoDealSeconds: number;
  /** Seconds the dealer has to pick the game in Dealer's Choice. */
  pickSeconds: number;
  /** Seconds between the end of one hand and the start of the next. */
  nextHandSeconds: number;
}

export const STAND_IN_RULES: Readonly<HouseRules> = Object.freeze({
  boot: 10,
  seenMultiplier: 2,
  stakeCapMultiple: 64,
  maxBlindTurns: null,
  cardsPerPlayer: 3,
  showOnlyWithTwo: true,
  showTie: 'requester_loses',
  startingCoins: 1000,
  loansAllowed: true,
  loanAmount: 500,
  loanBelowBootMultiple: 6,
  turnSeconds: 20,
  autoDealSeconds: 8,
  pickSeconds: 10,
  nextHandSeconds: 9,
});

/** How a whole session is played. */
export type SessionMode = HandMode | 'dealers' | 'tour';

export const SESSION_MODES: readonly SessionMode[] = ['classic', 'muflis', 'ak47', 'joker', 'four', 'dealers', 'tour'];
export const HAND_MODES: readonly HandMode[] = ['classic', 'muflis', 'ak47', 'joker', 'four'];

export const MODE_NAMES: Record<SessionMode, string> = {
  classic: 'Classic Danka',
  muflis: 'Muflis',
  ak47: 'AK47',
  joker: 'Joker Draw',
  four: 'Best of Four',
  dealers: "Dealer's Choice",
  tour: 'Tournament Night',
};

/** Tournament Night: the boot doubles every 2 hands, and there are no loans. */
export const tournamentBoot = (rules: HouseRules, hand: number): number => rules.boot * 2 ** Math.floor((hand - 1) / 2);

export const MAX_SEATS = 7;
