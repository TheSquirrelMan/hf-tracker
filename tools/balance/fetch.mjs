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

async function api(path, params = {}) {
  const token = await accessToken();
  const url = `${API}${path}?` + new URLSearchParams(params);
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const msg = j?.error?.message || r.statusText;
    // Never echo the URL — it carries the query, and an error message is a second
    // channel. Path only.
    if (r.status === 403 && /not been used|disabled|accessNotConfigured/i.test(msg)) {
      throw new Error(`Gmail API not enabled for this OAuth client's project (HTTP 403). Path ${path}`);
    }
    throw new Error(`Gmail ${path} HTTP ${r.status}: ${msg}`);
  }
  return r.json();
}

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
export async function getMessages(ids, { concurrency = 8, onProgress } = {}) {
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
