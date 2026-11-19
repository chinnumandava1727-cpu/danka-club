import { cryptoRandInt } from '@danka/engine';

/** No 0/O, 1/I/L: codes are read out loud and typed from WhatsApp. 31^6 ≈ 887 million codes. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[cryptoRandInt(CODE_ALPHABET.length)];
  return code;
}

export const normaliseCode = (raw: string): string => raw.trim().toUpperCase();
export const isValidCode = (code: string): boolean => CODE_RE.test(code);

/** Rooms that never start expire after 24 hours. */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
