/**
 * DANKA CLUB house rules, as written by the group ("Complete Game Rules, Regulations &
 * Developer Specification", sections 1–21). Every number in the game comes from here.
 */
export interface DankaRules {
  /** §2 Minimum and maximum active players. */
  minPlayers: number;
  maxPlayers: number;
  /** §3 Coins each player receives when they join. */
  startingCoins: number;
  /** §13 Maximum cumulative bank loan per player. */
  maxLoan: number;
  /** Rule update 1: compulsory coin every player puts in the pot at the start of each game. */
  openingCoins: number;
  /** §7 Cost of one Blind action and one Seen action. There is no Chaal. */
  blindCost: number;
  seenCost: number;
  /** §10 Cost of a Sideshow request. */
  sideshowCost: number;
  /** §9 Extra Blind actions allowed once every other active player is Seen. */
  extraBlindActions: number;
  /** Cards per player in a normal game. */
  normalCards: number;
  /** §5 Cards per player in the four compulsory Well Cut games. */
  wellCutSequence: number[];
  /** Turn timer, used only when the admin switches it on (off by default). On time-out the player packs. */
  turnSeconds: number;
  /** §14 Length of a playing period; Placecut follows the game in progress when it ends. */
  roundMinutes: number;
  /** Pause between the end of one game and the start of the next. */
  nextGameSeconds: number;
  /**
   * §5 The Well Cut timing bar. A slider runs up and down a bar; the dealer stops it.
   * Stopping within `wellCutZone` percent of the middle (either side) is a Well Cut.
   * Tuned for about 3–5 Well Cuts per 80 games.
   */
  wellCutZone: number;
  /** Time for the first pass, ms. Each pass varies by ±`cutBarJitter` and is `cutBarAccel` times the last, down to `cutBarFloor` × the first. */
  cutBarPassMs: number;
  cutBarJitter: number;
  cutBarAccel: number;
  cutBarFloor: number;
  /** Lead-in before the slider starts moving, so every phone sees it start. */
  cutBarLeadMs: number;
}

export const DANKA_RULES: Readonly<DankaRules> = Object.freeze({
  minPlayers: 2,
  maxPlayers: 10,
  startingCoins: 100,
  maxLoan: 100,
  openingCoins: 1,
  blindCost: 1,
  seenCost: 2,
  sideshowCost: 2,
  extraBlindActions: 3,
  normalCards: 3,
  wellCutSequence: [4, 3, 2, 1],
  turnSeconds: 30,
  roundMinutes: 20,
  nextGameSeconds: 8,
  wellCutZone: 1.5,
  cutBarPassMs: 600,
  cutBarJitter: 0.3,
  cutBarAccel: 0.91,
  cutBarFloor: 0.55,
  cutBarLeadMs: 1200,
});

export const MAX_SEATS = 10;
