// Gmail transport for the balance deriver.
//
// THE ONE RULE: enumerate at MESSAGE level. `users.messages.list` pages over messages,
// so every message is returned exactly once. A thread SEARCH returns only the messages
// of a thread that matched the query, and repeated searches return different subsets —
// measured 2026-09-22, one USAA debit thread held 13 messages and search surfaced 5,
// hiding a $4,372.74 payment and putting the derived balance $5,032 too high with no
// error anywhere. `listMessages` below is the only enumeration this repo may use.
//
// Timestamps come from `internalDate` (epoch ms, unambiguous), never the Date header.

import { accessToken } from './gmail-auth.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── PACING ──────────────────────────────────────────────────────────────────────
// Gmail meters "quota units per user per minute" and `messages.get` is not cheap, so a
// few hundred in a burst returns HTTP 403 whose message says *quota*, not permissions —
// it reads exactly like an auth failure and is not one. Measured 2026-09-22: 263
// messages over 90 threads tripped it, and per-request exponential backoff did NOT fix
// it, because every worker's retry fires at once and re-bursts. Backoff has to be
// GLOBAL, not per request.
//
// So: one shared gate. Every call waits its turn behind a minimum inter-request gap,
// and a rate-limit response widens that gap for everybody (and pauses new starts)
// rather than just rescheduling the one request that lost. The gap narrows slowly once
// requests succeed, so a long run settles near the fastest rate the quota allows.
let gap = 120;                 // ms between requests, adaptive
let nextSlot = 0;              // earliest time the next request may start
const MIN_GAP = 60, MAX_GAP = 4000;

async function gate() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await sleep(at - now);
}
function slowDown() { gap = Math.min(MAX_GAP, Math.max(gap * 2, 250)); nextSlot = Date.now() + gap * 4; }
function speedUp() { gap = Math.max(MIN_GAP, gap - 2); }

async function api(path, params = {}, attempt = 0) {
  await gate();
  const token = await accessToken();
  const url = `${API}${path}?` + new URLSearchParams(params);
  let r;
  try {
    r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    // Network blip — same treatment, but never echo the URL.
    if (attempt < 8) { slowDown(); return api(path, params, attempt + 1); }
    throw new Error(`Gmail ${path} network error: ${e.message}`);
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const msg = j?.error?.message || r.statusText;
    const rateLimited = r.status === 429
      || (r.status === 403 && /rate|quota|userRateLimit|limit exceeded/i.test(msg))
      || r.status >= 500;
    if (rateLimited && attempt < 8) {
      const retryAfter = Number(r.headers.get('retry-after')) * 1000;
      slowDown();
      if (retryAfter) await sleep(retryAfter);
      return api(path, params, attempt + 1);
    }
    // Never echo the URL — it carries the query, and an error message is a second
    // channel. Path only.
    if (r.status === 403 && /not been used|disabled|accessNotConfigured/i.test(msg)) {
      throw new Error(`Gmail API not enabled for this OAuth client's project (HTTP 403). Path ${path}`);
    }
    if (rateLimited) throw new Error(`Gmail ${path} still rate-limited after ${attempt} retries (gap ${gap}ms): ${msg}`);
    throw new Error(`Gmail ${path} HTTP ${r.status}: ${msg}`);
  }
  speedUp();
  return r.json();
}

export const pace = () => ({ gap });

/**
 * Page every message id matching `q`. Never returns a partial set silently: it follows
 * nextPageToken to exhaustion and reports how many pages it took.
 */
export async function listMessages(q, { max = 2000 } = {}) {
  const ids = [];
  let pageToken, pages = 0;
  do {
    const params = { q, maxResults: '500' };
    if (pageToken) params.pageToken = pageToken;
    const page = await api('/messages', params);
    pages++;
    for (const m of page.messages || []) ids.push({ id: m.id, threadId: m.threadId });
    pageToken = page.nextPageToken;
    if (ids.length >= max) break;
  } while (pageToken);
  return { ids, pages, complete: !pageToken };
}

/** Every message in one thread — the sanctioned second enumeration, for cross-checking. */
export async function threadMessageIds(threadId) {
  const t = await api(`/threads/${threadId}`, { format: 'minimal' });
  return (t.messages || []).map(m => m.id);
}

const b64 = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

// USAA sends multipart. The fixtures in parsers.test.mjs are DECODED PLAIN TEXT, so
// text/plain is what the parsers expect; HTML is stripped to the same shape only as a
// fallback, because a tag-stripped body still has to yield "$25.00 came out of your
// account ending in 1111" contiguously for the regexes to bite.
function bodyText(payload) {
  const walk = (p, want) => {
    if (!p) return null;
    if (p.mimeType === want && p.body?.data) return b64(p.body.data);
    for (const part of p.parts || []) { const r = walk(part, want); if (r) return r; }
    return null;
  };
  const plain = walk(payload, 'text/plain');
  if (plain) return plain;
  const html = walk(payload, 'text/html');
  if (html) {
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n');
  }
  if (payload?.body?.data) return b64(payload.body.data);
  return '';
}

/** One message in the shape `toEvent()` takes: {internalDate, subject, body}. */
export async function getMessage(id) {
  const m = await api(`/messages/${id}`, { format: 'full' });
  const h = Object.fromEntries((m.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  return {
    id: m.id,
    threadId: m.threadId,
    internalDate: m.internalDate,
    subject: h.subject || '',
    from: h.from || '',
    body: bodyText(m.payload),
  };
}

/** Fetch many, with a small concurrency cap so Gmail does not rate-limit us. */
export async function getMessages(ids, { concurrency = 4, onProgress } = {}) {
  const out = new Array(ids.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      out[i] = await getMessage(typeof ids[i] === 'string' ? ids[i] : ids[i].id);
      if (onProgress) onProgress(++done, ids.length);
    }
  }));
  return out;
}

// `from:usaa` not `from:usaa.com` — Gmail's from: is a substring match and the sender
// may be on a subdomain.
export const USAA_QUERY = (days = 35) => `from:usaa newer_than:${days}d`;
