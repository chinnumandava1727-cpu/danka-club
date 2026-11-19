import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface Identity {
  uid: string;
  name: string;
}

export interface AuthEnv {
  AUTH_MODE: string;
  FIREBASE_PROJECT_ID: string;
}

export class AuthError extends Error {}

// Google's public keys for Firebase ID tokens. jose caches them between requests.
const FIREBASE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_account/v1/jwk/securetoken@system.gserviceaccount.com'));

/**
 * Turns a bearer token into a player identity.
 * - dev mode: "dev:<uid>:<name>" (local testing only; never deploy with AUTH_MODE=dev)
 * - firebase mode: a Firebase Authentication ID token from Google sign-in in the app
 */
export async function authenticate(token: string | null, env: AuthEnv): Promise<Identity> {
  if (!token) throw new AuthError('Sign in first.');
  if (env.AUTH_MODE === 'dev') {
    const m = /^dev:([A-Za-z0-9_-]{1,40}):(.{1,24})$/.exec(token);
    if (!m) throw new AuthError('Bad dev token. Use dev:<uid>:<name>.');
    return { uid: `dev_${m[1]}`, name: decodeURIComponent(m[2]) };
  }
  if (env.AUTH_MODE !== 'firebase' || !env.FIREBASE_PROJECT_ID) throw new AuthError('Server sign-in is not configured.');
  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    if (!payload.sub) throw new Error('no subject');
    const name = (payload.name as string | undefined) ?? (payload.email as string | undefined)?.split('@')[0] ?? 'Player';
    return { uid: payload.sub, name: name.slice(0, 24) };
  } catch {
    throw new AuthError('Your sign-in has expired. Sign in again.');
  }
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7);
  // Browsers cannot set headers on WebSocket connections, so the app passes the token in the URL for /ws.
  return new URL(req.url).searchParams.get('token');
}
