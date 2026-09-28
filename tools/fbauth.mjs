// Admin access to the Realtime Database for the desktop tools, from a service-account key.
//
// WHY: the database rules are being closed (it was world-readable AND world-writable, and
// app_config handed out the dataSecret). A service-account token is an admin credential —
// it bypasses the rules — and the key does not expire, so a timer can use it unattended.
//
// The key lives at dotfiles/secrets/hft-firebase-sa.json (0600, gitignored). Neither the
// key nor a minted token is ever printed; errors carry the HTTP status and Google's
// error code only.

import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';

const KEY_FILE = process.env.HFT_FIREBASE_SA || '/home/jay/dotfiles/secrets/hft-firebase-sa.json';
export const DB = 'https://hf-tracker-81e76-default-rtdb.firebaseio.com';
const SCOPES = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';

let cached = null;   // { token, exp }

const b64url = (s) => Buffer.from(s).toString('base64url');

export async function accessToken() {
  if (cached && cached.exp - 60 > Date.now() / 1000) return cached.token;
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPES, aud: key.token_uri, iat: now, exp: now + 3600,
  }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key, 'base64url');
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`service-account token: HTTP ${res.status} ${data.error || ''}`);
  cached = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cached.token;
}

// Authenticated URL for a database path, e.g. dbUrl('app_config') or dbUrl(`hft/${s}/state`).
// Until the key exists this falls back to an unauthenticated URL, which works only while
// the rules are still open.
export async function dbUrl(path) {
  if (!existsSync(KEY_FILE)) return `${DB}/${path}.json`;
  return `${DB}/${path}.json?access_token=${encodeURIComponent(await accessToken())}`;
}

// fetch wrapper that strips the query string from any thrown error — the token rides in
// the URL, and a thrown fetch error is a second channel for it.
export async function dbFetch(path, init) {
  try {
    return await fetch(await dbUrl(path), init);
  } catch (e) {
    throw new Error(`db ${init?.method || 'GET'} ${path}: ${e.cause?.code || e.name}`);
  }
}
