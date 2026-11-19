// Guest identity for the test phase: a long random id kept on this phone plus a display name.
// Google sign-in (Firebase) replaces this before a wider release.
export interface Me {
  uid: string;
  name: string;
}

const KEY = 'danka-me';

export function loadMe(): Me | null {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || 'null');
    return m && m.uid && m.name ? m : null;
  } catch {
    return null;
  }
}

export function saveMe(name: string): Me {
  const prev = loadMe();
  const uid = prev?.uid ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const me = { uid, name: name.trim().slice(0, 24) };
  try { localStorage.setItem(KEY, JSON.stringify(me)); } catch { /* private mode */ }
  return me;
}

export const tokenFor = (me: Me): string => `guest:${me.uid}:${encodeURIComponent(me.name)}`;
