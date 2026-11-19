# DANKA CLUB

Private 7-player Danka card game. Coins have no cash value.

| Folder | What it is |
| --- | --- |
| `packages/engine` | The rules engine: cards, cryptographic shuffle, hand ranking, all game modes, betting, loans, fairness proof, and what each phone may see. Pure TypeScript, no I/O. |
| `server` | Cloudflare Worker + one Durable Object per room. Holds the deck, turns, timers and coins; talks to the 7 phones over WebSockets. |
| `app` | (next) React + Vite + Capacitor Android app. |

## House rules

**Every rule lives in `packages/engine/src/rules.ts` (`HouseRules`).** The current values (`STAND_IN_RULES`)
are standard Teen Patti, used only until the group's own rules are written in. Nothing else in the code
hard-codes a rule. Still missing from the spec: betting details, Blind/Seen, Show, hand ranking, Well Cut,
the random card count, banking, loans and settlement (open questions Q1–Q12).

Already implemented from the spec:
- The first player to enter deals game 1; the admin cannot change it. Each hand's winner deals the next.
- The server shuffles a fresh 52-card deck every hand (crypto RNG, Fisher–Yates without modulo bias)
  and locks cards to seats before the dealer's deal, which is ceremonial. Unselected cards never leave the server.
- Cards are dealt clockwise from the dealer's left. Each phone only ever receives its own cards.
- Fairness proof: SHA-256 of `deck|salt` is published before the deal; deck and salt are revealed after the hand.
- Exactly 7 seats in entry order; an 8th player is refused; reconnecting returns you to your seat.
- Turn timer with auto-pack, auto-deal, room codes without 0/O/1/I/L, 24-hour expiry, admin closes between hands.
- Modes: Classic, Muflis, AK47, Joker Draw, Best of Four, Dealer's Choice, Tournament Night.

## Run it

```bash
npm install
npm test                 # engine unit tests
npm run dev              # local server on http://127.0.0.1:8787 (AUTH_MODE=dev)
npm run sim              # in another terminal: 7 bots play a game night and check everything
node server/scripts/sim.mjs dealers 5   # any mode, any number of hands
```

## Protocol (phone ↔ room)

- `POST /api/rooms` `{ mode }` with `Authorization: Bearer <token>` → `{ code, joinUrl }`
- `GET /api/rooms/:code` → can I join? (`room_not_found`, `invalid_code`, full, expired)
- `GET /api/rooms/:code/ws?token=…` → WebSocket. Messages are typed in `server/src/protocol.ts`.
  Every `state` message is personal (`viewFor`) and carries `events` for animations.
- `GET /j/:code` → the WhatsApp invite page (opens `dankaclub://join/CODE`).

Bets carry a client-made `id`; a resent bet is acknowledged but never charged twice.

## Deploy (later)

1. Firebase project → enable Google sign-in. Set `AUTH_MODE` to `firebase` and `FIREBASE_PROJECT_ID` in `server/wrangler.jsonc`.
2. `npx wrangler login` then `npm run deploy -w @danka/server`.

To do before launch: join rate limiting per IP (spec: 10/min), pause vote, D1 for club stats and history.
