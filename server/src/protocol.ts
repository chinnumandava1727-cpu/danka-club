import type { Action, GameEvent, HandMode, PlayerView, SessionMode } from '@danka/engine';

/** Throwables from the spec (section 5.2). */
export const THROWABLES = ['rose', 'chai', 'fire', 'tomato', 'clap'] as const;
export type Throwable = (typeof THROWABLES)[number];

/** Messages a phone sends to its room. */
export type ClientMsg =
  | { t: 'ready'; ready: boolean }
  | { t: 'mode'; mode: SessionMode }
  | { t: 'size'; size: number }
  | { t: 'start' }
  | { t: 'pick'; mode: HandMode }
  | { t: 'deal' }
  /** `id` is a client-made unique id so a resend after a dropout never doubles a bet. */
  | { t: 'act'; id: string; action: Action }
  | { t: 'next' }
  | { t: 'react'; to: number; kind: Throwable }
  | { t: 'chat'; text: string }
  | { t: 'leave' }
  | { t: 'close' }
  | { t: 'ping'; c: number };

/** Messages the room sends to a phone. Every state message is personal: it only contains that player's cards. */
export type ServerMsg =
  | { t: 'state'; seq: number; code: string; view: PlayerView; events: GameEvent[] }
  | { t: 'react'; from: number; to: number; kind: Throwable }
  | { t: 'chat'; from: number; text: string; at: number }
  | { t: 'ack'; id: string }
  | { t: 'error'; code: string; message: string; ref?: string }
  | { t: 'pong'; c: number; s: number };

/** WebSocket close codes the app can show messages for. */
export const CLOSE = {
  REJECTED: 4000, // could not join: see the error message sent just before
  REPLACED: 4001, // the same player connected from another phone or tab
  LEFT: 4002,
  ROOM_CLOSED: 4003,
} as const;
