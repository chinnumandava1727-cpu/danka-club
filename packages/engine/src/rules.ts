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
  /** §14 Length of a round before Placecut. */
  roundMinutes: number;
  /** Turn timer, used only when the admin switches it on (off by default). On time-out the player packs. */
  turnSeconds: number;
  /** Pause between the end of one game and the start of the next. */
  nextGameSeconds: number;
}

export const DANKA_RULES: Readonly<DankaRules> = Object.freeze({
  minPlayers: 2,
  maxPlayers: 7,
  startingCoins: 100,
  maxLoan: 100,
  blindCost: 1,
  seenCost: 2,
  sideshowCost: 2,
  extraBlindActions: 3,
  normalCards: 3,
  wellCutSequence: [4, 3, 2, 1],
  roundMinutes: 20,
  turnSeconds: 30,
  nextGameSeconds: 8,
});

export const MAX_SEATS = 7;
