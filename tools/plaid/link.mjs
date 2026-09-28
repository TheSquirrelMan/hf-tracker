// Link a bank to Plaid — the step Plaid has no dashboard page for.
//
// WHY THIS EXISTS: Plaid's dashboard hands out API keys but has nowhere to connect YOUR
// OWN accounts. An Item (one bank login) is only ever created through Plaid Link, the
// JS widget, driven by a link_token this server mints. So: run this, open the printed
// localhost URL, pick a bank, log in; the public_token comes back here and is exchanged
// for a long-lived access_token.
//
// TRIAL PLAN CAP, measured from Plaid's billing docs 2026-09-26: 10 Production Items,
// lifetime. `/item/remove` does NOT give a slot back. Never link the same bank twice —
// the page lists what is already linked, and one login covers every account at a bank.
//
// OAuth banks (USAA, Capital One, Chase) open in a popup on desktop, so no redirect_uri
// is registered or sent.
//
// NOTHING SECRET IS EVER PRINTED. Keys come from dotfiles/secrets/secrets.env
// (`plaid_id`, `plaid_s`); access tokens go to ITEMS_FILE, 0600, outside this public
// repo. Errors print Plaid's error_code/message only, never the request body.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

const ENV_FILE = process.env.HFT_PLAID_ENV || '/home/jay/dotfiles/secrets/secrets.env';
export const ITEMS_FILE = process.env.HFT_PLAID_ITEMS || '/home/jay/dotfiles/secrets/hft-plaid-items.json';
const HOST = 'https://production.plaid.com';
const PORT = Number(process.env.PORT || 7795);

function loadKeys() {
  const env = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  if (!env.plaid_id || !env.plaid_s) throw new Error(`plaid_id / plaid_s missing from ${ENV_FILE}`);
  return { client_id: env.plaid_id, secret: env.plaid_s };
}

export function loadItems() {
  return existsSync(ITEMS_FILE) ? JSON.parse(readFileSync(ITEMS_FILE, 'utf8')) : [];
}

function saveItems(items) {
  writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2), { mode: 0o600 });
  chmodSync(ITEMS_FILE, 0o600);
}

export async function plaid(path, body) {
  const res = await fetch(HOST + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...loadKeys(), ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`plaid ${path}: ${data.error_code} — ${data.error_message}`);
  return data;
}

const page = (items) => `<!doctype html><meta charset="utf-8"><title>Link a bank</title>
<style>body{font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px}
button{font-size:18px;padding:12px 20px}li{margin:4px 0}#out{white-space:pre-wrap}</style>
<h1>Link a bank to HF Tracker</h1>
<p><b>${items.length} of 10</b> Trial slots used. Removing an Item does not free a slot —
do not link a bank that is already below.</p>
<ul>${items.map(i => `<li>${i.institution} — ${i.accounts.map(a => `${a.name} …${a.mask}`).join(', ')}</li>`).join('') || '<li>(none yet)</li>'}</ul>
<button id="go">Link a bank</button>
<p id="out"></p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const out = document.getElementById('out');
document.getElementById('go').onclick = async () => {
  out.textContent = 'Starting…';
  const { link_token, error } = await (await fetch('/token', { method: 'POST' })).json();
  if (error) { out.textContent = error; return; }
  Plaid.create({
    token: link_token,
    onSuccess: async (public_token, metadata) => {
      out.textContent = 'Saving…';
      const r = await (await fetch('/exchange', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token, metadata }) })).json();
      out.textContent = r.error || ('Linked ' + r.institution + ': ' + r.accounts + '\\nReload to link another.');
    },
    onExit: (err) => { out.textContent = err ? ('Exited: ' + err.error_code + ' — ' + (err.display_message || err.error_message)) : 'Closed without linking.'; },
  }).open();
};
</script>`;

function readBody(req) {
  return new Promise((ok) => { let s = ''; req.on('data', c => s += c); req.on('end', () => ok(s)); });
}

function reply(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadKeys(); // fail fast, before printing a URL
  createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') return reply(res, 200, 'text/html', page(loadItems()));
      if (req.method === 'POST' && req.url === '/token') {
        const { link_token } = await plaid('/link/token/create', {
          client_name: 'HF Tracker', user: { client_user_id: 'jay' },
          products: ['transactions'], optional_products: ['liabilities'],
          transactions: { days_requested: 730 },
          country_codes: ['US'], language: 'en',
        });
        return reply(res, 200, 'application/json', JSON.stringify({ link_token }));
      }
      if (req.method === 'POST' && req.url === '/exchange') {
        const { public_token, metadata } = JSON.parse(await readBody(req));
        const { access_token, item_id } = await plaid('/item/public_token/exchange', { public_token });
        const entry = {
          item_id, access_token,
          institution: metadata.institution?.name, institution_id: metadata.institution?.institution_id,
          accounts: (metadata.accounts || []).map(a => ({ id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
          linked_at: new Date().toISOString(),
        };
        const items = loadItems();
        items.push(entry);
        saveItems(items);
        const accounts = entry.accounts.map(a => `${a.name} …${a.mask}`).join(', ');
        console.log(`linked: ${entry.institution} — ${accounts}  (${items.length}/10 Trial slots)`);
        return reply(res, 200, 'application/json', JSON.stringify({ institution: entry.institution, accounts }));
      }
      reply(res, 404, 'text/plain', 'not found');
    } catch (e) {
      console.error(String(e.message || e));
      reply(res, 500, 'application/json', JSON.stringify({ error: String(e.message || e) }));
    }
  }).listen(PORT, '127.0.0.1', () => console.log(`OPEN http://localhost:${PORT}/`));
}
