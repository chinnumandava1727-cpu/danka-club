import type { Action, GameEvent, PlayerView, Tx, sessionReport } from '@danka/engine';

/** Throwables from the spec (section 5.2 of the design doc). */
export const THROWABLES = ['rose', 'chai', 'fire', 'tomato', 'clap'] as const;
export type Throwable = (typeof THROWABLES)[number];

/** Messages a phone sends to its room. */
export type ClientMsg =
  | { t: 'start_game' }
  | { t: 'call_off' }
  | { t: 'timer'; on: boolean }
  | { t: 'size'; size: number }
  /** The dealer's STOP on the Well Cut timing bar: the server time at the tap (from the phone's synced clock). */
  | { t: 'cut'; at: number }
  | { t: 'deal' }
  /** `id` is a client-made unique id so a resend after a dropout is never applied twice. */
  | { t: 'act'; id: string; action: Action }
  | { t: 'loan'; id: string; amount: number }
  /** Final lending rule: ask another player (by seat) for a loan, answer one, or cancel your own. */
  | { t: 'p2p_ask'; to: number; amount: number }
  | { t: 'p2p_answer'; id: number; accept: boolean }
  | { t: 'p2p_cancel' }
  | { t: 'leave' }
  | { t: 'report' }
  | { t: 'react'; to: number; kind: Throwable }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number };

export type SessionReport = ReturnType<typeof sessionReport> & { ledger: Tx[]; code: string };

/** Messages the room sends to a phone. Every state message is personal: only that player's cards. */
export type ServerMsg =
  | { t: 'state'; seq: number; code: string; view: PlayerView; events: GameEvent[] }
  | { t: 'report'; report: SessionReport }
  | { t: 'react'; from: number; to: number; kind: Throwable }
  | { t: 'chat'; from: number; text: string; at: number }
  | { t: 'ack'; id: string }
  | { t: 'error'; code: string; message: string; ref?: string }
  | { t: 'pong'; c: number; s: number };

/** WebSocket close codes the app can show messages for. */
export const CLOSE = {
  REJECTED: 4000,
  REPLACED: 4001,
  LEFT: 4002,
  ROOM_CLOSED: 4003,
} as const;
