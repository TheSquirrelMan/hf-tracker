// Gmail OAuth for the balance deriver — loopback consent once, refresh forever after.
//
// WHY THIS CLIENT: the Google Cloud project behind `dotfiles/secrets/gmail-mcp.env`
// already has the Gmail API enabled and `gmail.readonly` on its consent screen, and the
// same client_id is registered as an INSTALLED (Desktop) client — which is what lets us
// use an arbitrary loopback port here without registering a redirect URI. Verified
// 2026-09-22 by hashing the two stored client_ids against each other: identical.
//
// KNOWN LIMIT, measured not assumed: the consent screen's publishing status is
// **Testing**, and Google expires a Testing app's refresh token after 7 days. The
// calendar MCP's stored token shows `refresh_token_expires_in = 604799` — exactly that.
// So an UNATTENDED service on this client re-consents weekly. The fix is one click in
// the Cloud console (OAuth consent screen -> Publish app): an "In production" app issues
// non-expiring refresh tokens even while unverified; the only cost is a warning screen
// on the consent click. Verification/CASA is only needed to remove that warning.
//
// NOTHING IN HERE IS EVER PRINTED. No token, no code, no client_secret reaches stdout,
// and errors are re-raised with the query string stripped — a thrown fetch error is a
// second channel for whatever was in the URL.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';

const ENV_FILE = process.env.HFT_GMAIL_ENV || '/home/jay/dotfiles/secrets/gmail-mcp.env';
export const TOKEN_FILE = process.env.HFT_GMAIL_TOKEN || '/home/jay/dotfiles/secrets/hft-gmail-token.json';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
// Read-only, deliberately. This process must never be able to send or delete mail.
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function client() {
  const env = Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  const id = env.GOOGLE_CLIENT_ID, secret = env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error(`no GOOGLE_CLIENT_ID/SECRET in ${ENV_FILE}`);
  return { id, secret };
}

// Google's error bodies are safe to show; the request URL/body is not. Never pass the
// body through — quote only status and the `error` field.
async function postForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}: ${j.error || 'unknown'} ${j.error_description || ''}`);
  return j;
}

/** One-shot loopback consent. Resolves once the token file is written. */
export async function consent() {
  const { id, secret } = client();
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');

  let resolve, reject;
  const done = new Promise((a, b) => { resolve = a; reject = b; });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const reply = (msg) => { res.writeHead(200, { 'content-type': 'text/plain' }).end(msg); };
    try {
      if (u.searchParams.get('state') !== state) throw new Error('state mismatch — ignoring this callback');
      const err = u.searchParams.get('error');
      if (err) throw new Error(`consent denied: ${err}`);
      const code = u.searchParams.get('code');
      if (!code) throw new Error('no code in callback');

      const tok = await postForm(TOKEN, {
        code, client_id: id, client_secret: secret,
        redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
        grant_type: 'authorization_code', code_verifier: verifier,
      });
      save(tok);
      reply('HF Tracker: Gmail access granted. You can close this tab.');
      resolve({ scope: tok.scope, refresh_token_expires_in: tok.refresh_token_expires_in ?? null });
    } catch (e) {
      reply(`Failed: ${e.message}`);
      reject(e);
    } finally {
      setTimeout(() => server.close(), 250);
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `${AUTH}?` + new URLSearchParams({
    client_id: id,
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',            // force a refresh_token even on re-consent
    state,
  });
  console.log('OPEN THIS URL:\n' + url);
  return done;
}

function save(tok) {
  const prev = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : {};
  const out = {
    // Google omits refresh_token on a plain refresh — keep the one we have.
    refresh_token: tok.refresh_token || prev.refresh_token,
    access_token: tok.access_token,
    expires_at: Date.now() + (Number(tok.expires_in || 0) - 60) * 1000,
    scope: tok.scope || prev.scope,
    obtained_at: tok.refresh_token ? Date.now() : (prev.obtained_at ?? Date.now()),
    refresh_token_expires_in: tok.refresh_token_expires_in ?? prev.refresh_token_expires_in ?? null,
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 2));
  chmodSync(TOKEN_FILE, 0o600);
}

/** A valid access token, refreshing if needed. Throws a clear error if consent is owed. */
export async function accessToken() {
  if (!existsSync(TOKEN_FILE)) throw new Error(`no token at ${TOKEN_FILE} — run: node tools/balance/gmail-auth.mjs`);
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  if (t.access_token && Date.now() < (t.expires_at || 0)) return t.access_token;
  if (!t.refresh_token) throw new Error('token file has no refresh_token — re-run consent');
  const { id, secret } = client();
  let tok;
  try {
    tok = await postForm(TOKEN, { client_id: id, client_secret: secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  } catch (e) {
    // The 7-day Testing expiry surfaces exactly here, as invalid_grant.
    if (String(e.message).includes('invalid_grant')) {
      const age = t.obtained_at ? ((Date.now() - t.obtained_at) / 86400e3).toFixed(1) : '?';
      throw new Error(`refresh rejected (invalid_grant) after ${age} days. The consent screen is in Testing, `
        + `which expires refresh tokens at 7 days. Publish the app, or re-run: node tools/balance/gmail-auth.mjs`);
    }
    throw e;
  }
  save(tok);
  return tok.access_token;
}

/** Age of the stored grant, so a caller can warn before it silently dies. */
export function tokenAge() {
  if (!existsSync(TOKEN_FILE)) return null;
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  if (!t.obtained_at) return null;
  return { days: (Date.now() - t.obtained_at) / 86400e3, scope: t.scope };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await consent();
  console.log('ok — token written to', TOKEN_FILE);
  console.log('scope:', r.scope);
  if (r.refresh_token_expires_in) {
    console.log(`refresh_token_expires_in: ${r.refresh_token_expires_in}s (~${(r.refresh_token_expires_in / 86400).toFixed(1)} days)`);
    console.log('That is the Testing-mode limit. Publish the app to get a non-expiring refresh token.');
  }
}
