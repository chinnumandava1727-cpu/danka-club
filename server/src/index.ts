import { AuthError, authenticate, bearer } from './auth';
import { generateRoomCode, isValidCode, normaliseCode } from './codes';
import { invitePage } from './invite';
import { Room } from './room';

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  AUTH_MODE: string;
  FIREBASE_PROJECT_ID: string;
  /** Test only, honoured when AUTH_MODE is "dev": shorter periods and pauses for the bot simulation. */
  DEV_ROUND_SECONDS?: string;
  DEV_NEXT_GAME_SECONDS?: string;
  DEV_STARTING_COINS?: string;
  DEV_MAX_LOAN?: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: CORS });
const err = (code: string, message: string, status: number) => json({ error: code, message }, status);
const roomStub = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // Invite link shared on WhatsApp: /j/K7M2QX
      if (parts[0] === 'j' && parts[1]) {
        const code = normaliseCode(parts[1]);
        return new Response(invitePage(isValidCode(code) ? code : null), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      if (parts[0] !== 'api') return env.ASSETS ? env.ASSETS.fetch(req) : new Response('DANKA CLUB room server', { headers: CORS });

      // POST /api/rooms  { seats, bots }  → { code }   (bots = computer players to seat at once)
      if (parts[1] === 'rooms' && parts.length === 2 && req.method === 'POST') {
        const me = await authenticate(bearer(req), env);
        const body = (await req.json().catch(() => ({}))) as { seats?: number; bots?: number };
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = generateRoomCode();
          const res = await roomStub(env, code).fetch('https://room/init', {
            method: 'POST',
            body: JSON.stringify({ code, uid: me.uid, name: me.name, seats: Number(body.seats) || 7, bots: Math.max(0, Math.min(9, Math.floor(Number(body.bots) || 0))) }),
          });
          if (res.status === 409) continue; // code already taken: try another
          return json({ code, joinUrl: `${url.origin}/j/${code}` }, 201);
        }
        return err('code_unavailable', 'Could not create a room. Try again.', 503);
      }

      if (parts[1] === 'rooms' && parts[2]) {
        const code = normaliseCode(parts[2]);
        if (!isValidCode(code)) return err('invalid_code', "That code isn't valid. Codes are 6 characters and never use 0, O, 1, I or L.", 400);
        const stub = roomStub(env, code);

        // GET /api/rooms/:code → can I join?
        if (parts.length === 3 && req.method === 'GET') {
          const info = (await (await stub.fetch('https://room/info')).json()) as { exists: boolean };
          return info.exists ? json(info) : err('room_not_found', 'No room with that code. Check the code and try again.', 404);
        }

        // GET /api/rooms/:code/ws?token=… → WebSocket into the room
        if (parts[3] === 'ws') {
          if (req.headers.get('Upgrade') !== 'websocket') return err('expected_websocket', 'Expected a WebSocket.', 426);
          const me = await authenticate(bearer(req), env);
          const headers = new Headers(req.headers);
          headers.set('x-uid', me.uid);
          headers.set('x-name', me.name);
          return stub.fetch(new Request('https://room/ws', { headers }));
        }
      }
      return err('not_found', 'Not found.', 404);
    } catch (e) {
      if (e instanceof AuthError) return err('unauthorised', e.message, 401);
      console.error(e);
      return err('server_error', 'Something went wrong.', 500);
    }
  },
} satisfies ExportedHandler<Env>;
