# DANKA CLUB: notes for Claude Code

A private multiplayer recreation of one friend group's physical **Danka** card game (2–10 players, a room code,
**virtual coins only**). Owner: Rc (solo founder, not a professional coder; wants direct, plain answers and
working, tested results, not code walkthroughs).

- Live: https://danka-club.danka-club.workers.dev
- Deploy: **every push to `main` deploys automatically** (Cloudflare Workers Builds, about 2 minutes).
  There is no staging, so run the checks below before pushing.
- The house rules are in `README.md` (section "House rules"). They come from the group's own documents and
  change often. **Do not add standard Teen Patti features that are not in their rules** (no Chaal, no Raise,
  no extra modes).

## Layout (npm workspaces)

| Path | What |
| --- | --- |
| `packages/engine` | Pure TypeScript rules engine, no I/O. `src/danka.ts` state machine (games, Well Cut, betting, loans, Placecut, ledger, per-player views), `src/hands.ts` hand ranking (local rules), `src/rules.ts` every number (`DANKA_RULES`), `src/bots.ts` computer players. Tests in `test/` (vitest). |
| `server` | Cloudflare Worker + one Durable Object per room (`src/room.ts`): WebSocket hibernation, alarms, SQLite `ledger` and `settlements_v2`. `src/protocol.ts` message types. `scripts/sim.mjs` 7-player end-to-end simulation. |
| `app` | React 18 + Vite web app, served by the Worker as static assets. `src/screens/Room.tsx` is the table, waiting room, Placecut and admin screens. `src/casino.css` is the upright "Classic Casino" table, laid out in a fixed 430px-wide frame (`src/lib/tableFrame.ts`) that is scaled to the phone. |

## Commands

```bash
npm install
npm test             # engine rules tests (82 at last count); must all pass
npm run typecheck    # engine + server + app
npm run build        # builds app/dist (the Worker serves it)
# local server with short timers for testing (dev mode accepts short ids, used by the simulation):
cd server && npx wrangler dev --port 8787 --ip 127.0.0.1 --var AUTH_MODE:dev --var DEV_ROUND_SECONDS:40 --var DEV_NEXT_GAME_SECONDS:1
node server/scripts/sim.mjs   # against the local server; must print ALL CHECKS PASSED
```

Dev-only env vars (honoured only when `AUTH_MODE` is `dev`): `DEV_ROUND_SECONDS` (period length; the
compulsory Well Cut comes at half of it), `DEV_NEXT_GAME_SECONDS`, `DEV_STARTING_COINS`, `DEV_MAX_LOAN`.

UI changes were checked with Playwright (Python, Chrome) on phone viewports (390×844 and 360×640),
using "Play with computer" against computer players. Check UI changes on screen, not just with the type checker.

## Rules that must hold (the server is authoritative)

- All game logic lives in the engine and is enforced by the server, never only in the UI.
- Crypto shuffle with a SHA-256 commit/reveal fairness proof; action ids make resent moves apply once.
- **A Blind player's phone is never sent their own cards**; they arrive only after See (or once the game is over).
  Never reveal anyone's cards to the admin or other players.
- Coins are conserved: an opening coin from every player each game, Blind 1, Seen 2, pots, bonuses, bank loans
  (up to 100 per player), player-to-player loans (existing coins only, never new ones). Tests check conservation.
- Deal and play both go from the **dealer's right**, turning right; the player on the dealer's **left** stops
  the Well Cut slider; a Sideshow is asked of the next active player on the left.
- Well Cut: a slider stopped within 1.5% of the middle queues the 4/3/2/1-card sequence for the **next** game;
  plus one compulsory Well Cut 10 minutes into each 20-minute period (skipped if the period already had one).
- Tournament: 20-minute periods; after the time is up the current game (or Well Cut sequence) finishes, then
  everyone returns to the waiting room (Placecut) with all scores carried forward; admin adds or removes
  players and starts the next period; repeats until the admin calls it off (current game finishes first).
- Admin actions are logged in the ledger; the admin cannot see cards, change the shuffle or edit balances.
- Virtual coins only: no real money, no deposits or withdrawals, no payment details anywhere.

When the group sends a rule change: update the engine, update or add tests (many tests assume the turn order
and the opening coin), update the README house rules, run all the checks, then push.

## Git

- Commit as Rc's GitHub account:
  `git -c user.name="chinnumandava1727-cpu" -c user.email="chinnumandava1727-cpu@users.noreply.github.com" commit ...`
- Never commit secrets (`.dev.vars`, tokens).

## Open items

- Live voice chat in a room (planned, not built): one room-wide channel through Cloudflare Realtime SFU, with
  open mic or push-to-talk, per-player mute, admin mute and talking rings. Waiting on Rc for the Realtime App ID
  and the default talk mode.
- Android app (Capacitor) and Google sign-in (`AUTH_MODE: firebase`): deferred.
- Question for Rc: should a call-off wait for a queued Well Cut sequence to be played?
