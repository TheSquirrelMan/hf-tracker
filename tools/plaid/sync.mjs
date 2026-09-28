// Copy Plaid balances into the tracker's live state. DRY RUN unless --apply.
//
//   node tools/plaid/sync.mjs            # show what would change
//   node tools/plaid/sync.mjs --apply    # write, then read every field back
//
// Plaid is the source of truth for every account in FIELDS. Each write also records
// where the number came from under hft/<secret>/balSource/<field> — a SIBLING of
// state, so the PWA's whole-state save can never drop it. cardBals has no source field
// of its own, and that is how seeded estimates became indistinguishable from observed
// balances; balSource is the fix. The engine never reads it.
//
// Card balances use balances.current (includes charges since the statement), not
// last_statement_balance.
//
// Writes are per-field PUTs, never a whole-state PUT — code.gs and the PWA both hold
// copies of state, and a broad write races with them.

import { plaid, loadItems } from './link.mjs';
import { dbFetch } from '../fbauth.mjs';

// mask -> state path. Only accounts listed here are written; anything else linked is
// reported and ignored.
export const FIELDS = {
  '4496': 'bal4496',
  '0725': 'bal0725',
  '6764': 'bal6764',
  '4565': 'cardBals/cap4565',
  '7988': 'cardBals/cap7988',
};

let _secret = null;
async function secret() {
  if (_secret) return _secret;
  const cfg = await (await dbFetch('app_config')).json();
  if (!cfg || !cfg.dataSecret) throw new Error('could not read app_config');
  return (_secret = cfg.dataSecret);   // never printed
}
const get = async (path) => (await dbFetch(`hft/${await secret()}/${path}`)).json();
async function put(path, value) {
  const r = await dbFetch(`hft/${await secret()}/${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  return r.status;
}
const dig = (o, path) => path.split('/').reduce((x, k) => (x == null ? x : x[k]), o);

export async function readPlaid() {
  const rows = [];
  for (const it of loadItems()) {
    const r = await plaid('/accounts/balance/get', { access_token: it.access_token });
    for (const a of r.accounts) rows.push({ institution: it.institution, mask: a.mask, subtype: a.subtype, current: a.balances.current });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');
  const asOf = new Date().toISOString();
  const [rows, state] = await Promise.all([readPlaid(), get('state')]);

  const writes = [];
  for (const r of rows) {
    const path = FIELDS[r.mask];
    if (!path) { console.log(`  skip ${r.institution} …${r.mask} (${r.subtype}) — not mapped`); continue; }
    if (typeof r.current !== 'number') { console.log(`  skip ${path} — Plaid returned no current balance`); continue; }
    writes.push({ path, from: dig(state, path), to: r.current, src: `plaid ${r.institution} …${r.mask}` });
  }

  console.log(apply ? 'APPLYING\n' : 'DRY RUN — nothing written. Re-run with --apply.\n');
  for (const w of writes) console.log(`  ${w.path.padEnd(18)} ${JSON.stringify(w.from)}  ->  ${w.to}`);
  if (!apply) process.exit(0);

  let bad = 0;
  for (const w of writes) {
    const code = await put(`state/${w.path}`, w.to);
    const code2 = await put(`balSource/${w.path.replace('/', '_')}`, { src: w.src, asOf, prev: w.from ?? null });
    if (code !== 200 || code2 !== 200) { bad++; console.log(`  PUT ${w.path} HTTP ${code}/${code2}`); }
  }
  const after = await get('state');         // read back, never trust the status alone
  for (const w of writes) {
    const got = dig(after, w.path);
    const ok = got === w.to;
    if (!ok) bad++;
    console.log(`  read-back ${w.path.padEnd(18)} ${ok ? 'ok' : `MISMATCH got ${JSON.stringify(got)}`}`);
  }
  console.log(bad ? '\n  SOME WRITES DID NOT LAND' : `\n  all ${writes.length} writes verified (asOf ${asOf})`);
  process.exit(bad ? 1 : 0);
}
