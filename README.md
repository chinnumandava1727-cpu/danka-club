# DANKA CLUB

Private 7-player Danka card game. Coins have no cash value.

| Folder | What it is |
| --- | --- |
| `packages/engine` | The Danka rules engine: cards, cryptographic shuffle, hand ranking for 1–4 cards, Well Cut, betting, loans, bonuses, rounds, Placecut, ledger, fairness proof, and what each phone may see. Pure TypeScript, no I/O. |
| `server` | Cloudflare Worker + one Durable Object per room. Holds the deck, turns, timers and coins; talks to the 7 phones over WebSockets. |
| `app` | The game client: React + Vite. Served as a web game from the same Cloudflare address; wrapped with Capacitor for Android next. |

## House rules

The game follows the group's own rules document (DANKA CLUB Complete Game Rules, sections 1–21) and nothing else:
no Chaal, no Raise, no boot, no extra modes. The values live in `packages/engine/src/rules.ts` (`DANKA_RULES`);
the state machine is `packages/engine/src/danka.ts`; hand comparisons are `packages/engine/src/hands.ts`.

- 2–7 players. The first to enter is admin and deals game 1; every winner deals the next game (Well Cut games included).
- 100 coins each. Bank loans up to 100 per player in total, recorded as owed. Lose all 200 and you sit out until Placecut, then leave.
- Blind costs 1, Seen costs 2. Seeing your cards makes you Seen. Pack any time on your turn.
- Show only when two players remain, priced automatically (Blind 1, Seen 2). A Blind player can't Show against another Blind player.
- When everyone else is Seen, the last Blind player gets 3 more Blind turns, then their cards are shown automatically.
- Sideshow only when every active player is Seen: with the next active player on your left, costs 2, can't be refused,
  compared privately, weaker hand folds.
- **Well Cut timing bar.** The system shuffles; then a slider runs up and down a bar on every phone. The player on
  the **dealer's left** taps STOP (the dealer only deals); stopping within 1.5% of the middle (the gold line) is a **Well Cut**: four compulsory games of 4, 3, 2 and
  1 cards. The slider is fastest through the middle, changes speed every pass (crypto random) and speeds up, so it
  can't be learned: about 3–5 Well Cuts per 80 games. The server accepts a stop time only from the last 0.25 s before
  the tap arrived. The round clock never interrupts a Well Cut.
- Ranking follows the group's Local Card Rules (`packages/engine/src/hands.ts`):
  3 cards Trail > Pure Sequence > Sequence > Colour > Pair > High; 2 cards Pair (22 highest, then AA) > Pure Sequence >
  Sequence > Colour > High; 4 cards Four of a Kind, otherwise the best 3 of the 4; 1 card highest card.
  Ace runs: A-K-Q highest, A-2-3 next. Three of a Kind bonus pays in every 3-card game, Well Cut game 2 included.
  A Sequence needs every card in a different suit; Colour needs every card in one suit. Ties: sort highest first,
  compare values, then suits card by card (Spades > Hearts > Diamonds > Clubs), so there is never a draw.
- Bonus N×(N−1), only when the holder wins the game: Three of a Kind in normal 3-card games, Four of a Kind in Well Cut game 1.
- 20-minute rounds. When the clock runs out, the current game finishes, then **Placecut**: scorecard for everyone,
  new players may join, anyone may leave, admin starts the next round. Balances and loans carry forward.
- Admin: start rounds, table size, turn timer on/off (off by default; time out = pack), call off the session,
  export the settlement PDF. The admin can't see cards, touch the shuffle or edit balances; admin actions are logged.
- Fairness: crypto shuffle of a fresh deck every game, SHA-256 fingerprint of `deck|salt` published before the cut,
  revealed after the game. Every coin movement is an entry in a permanent ledger (Durable Object SQLite table).

Connection handling: 10 s heartbeat answered without waking the room, dead-connection detection, jittered reconnects,
resent actions applied once (action ids), 1.5 s grace on timed turns, double-tap lock, screen kept awake, room resume after refresh.

## Run it

```bash
npm install
npm test                 # engine unit tests
npm run build            # build the web game into app/dist
npm run dev              # local server + game on http://127.0.0.1:8787
# bots play two short rounds against a local server with 40-second rounds:
cd server && npx wrangler dev --port 8787 --ip 127.0.0.1 --var AUTH_MODE:dev --var DEV_ROUND_SECONDS:40 --var DEV_NEXT_GAME_SECONDS:1
node server/scripts/sim.mjs   # in another terminal
```

## Protocol (phone ↔ room)

- `POST /api/rooms` `{ seats }` with `Authorization: Bearer <token>` → `{ code, joinUrl }`
- `GET /api/rooms/:code` → can I join? (`room_not_found`, `invalid_code`, full, expired)
- `GET /api/rooms/:code/ws?token=…` → WebSocket. Messages are typed in `server/src/protocol.ts`.
  Every `state` message is personal (`viewFor`) and carries `events` for animations.
- `GET /j/:code` → the WhatsApp invite page (opens `dankaclub://join/CODE`).

Bets and loans carry a client-made `id`; a resent one is acknowledged but never applied twice.

## Deploy to Cloudflare (automatic, via Workers Builds)

Cloudflare builds and deploys straight from this GitHub repo on every push to `main`. No GitHub Actions or API tokens needed.

One-time setup in the Cloudflare dashboard:
1. **Workers & Pages → Create application → Import a repository → GitHub**. Authorise the Cloudflare app for `danka-club`.
2. Project name: **`danka-club`** (must match `name` in `server/wrangler.jsonc`).
3. Build settings:
   - Root directory / Path: **`server`**
   - Build command: **`cd .. && npm ci && npm run build`**
   - Deploy command: **`npx wrangler deploy`**
4. **Save and Deploy.** The game opens at `https://danka-club.<your-subdomain>.workers.dev`.

`.github/workflows/deploy.yml` does the same on GitHub Actions, but only when run manually.

Sign-in is in **guest** mode for the test phase: each phone keeps a long random id plus the name typed in.
Switch `AUTH_MODE` to `firebase` (and set `FIREBASE_PROJECT_ID`) when Google sign-in is added.

To do before a wider release: Android app (Capacitor), Google sign-in, join rate limiting per IP.
