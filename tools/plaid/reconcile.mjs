// Reconcile the email-built debitLog against Plaid's USAA checking transactions.
// DRY RUN ONLY for now — prints what it would do; there is no --apply yet.
//
//   node tools/plaid/reconcile.mjs
//
// Email alerts stay the FAST path: USAA reports no pending transactions to Plaid, and
// Plaid lags the alerts by days. Plaid is the CHECKER:
//   stamp — an email row that Plaid also has gets Plaid's transaction_id. Same account,
//           same event, two reporters, so exact amount + date within DATE_SLACK days is
//           a safe join here (never across accounts — USAA bundles transfers).
//   add   — a Plaid debit no email row covers (a missed alert). Only these new rows may
//           run side effects (card decrement, discretionary spend); a stamped row's side
//           effects already happened when the email logged it.
//   skip  — transfer / check / overdraft fee, the same list syncUSAADebits skips.
// Rows he has already dispositioned are never relabelled.
//
// Merchant strings: Plaid's `name` is cleaned ("McDonald's"); `original_description` is
// the bank's text in mixed case. Match on original_description uppercased and
// whitespace-collapsed, which is what the email parser does to its own string.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { plaid, loadItems } from './link.mjs';
import { dbFetch } from '../fbauth.mjs';
const DATE_SLACK = 4;
export const SKIP = ['CHECK #', 'OD FEE', 'USAA FUNDS TRANSFER'];   // mirrors code.gs

// matchDebit is loaded from code.gs itself, so the two paths cannot drift apart.
export function loadMatcher(codePath = new URL('../../code.gs', import.meta.url)) {
  const src = readFileSync(codePath, 'utf8');
  const a = src.indexOf('function matchDebit');
  const b = src.indexOf('\nfunction ', a + 10);
  const ctx = { Logger: { log() {} } };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + ';this.matchDebit = matchDebit;', ctx);
  return ctx.matchDebit;
}

export const normMerchant = (s) => s.toUpperCase().replace(/\s+/g, ' ').trim();
const isoOf = (usaa) => { const [m, d, y] = usaa.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
const usaaOf = (iso) => { const [y, m, d] = iso.split('-'); return `${+m}/${+d}/${y}`; };
const dayGap = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);
const dow = (iso) => new Date(iso + 'T12:00:00').getDay();

export async function plaidDebits(mask = '4496') {
  const usaa = loadItems().find(i => i.institution === 'USAA');
  const acct = usaa.accounts.find(a => a.mask === mask).id;
  let cursor = null, more = true;
  const tx = [];
  while (more) {
    const r = await plaid('/transactions/sync', {
      access_token: usaa.access_token, cursor, count: 500,
      options: { include_original_description: true },
    });
    tx.push(...r.added); cursor = r.next_cursor; more = r.has_more;
  }
  return tx
    .filter(t => t.account_id === acct && t.amount > 0 && !t.pending)
    .map(t => ({ id: t.transaction_id, date: t.date, amt: t.amount, merchant: normMerchant(t.original_description || t.name) }));
}

export function reconcile(log, debits, userBills, matchDebit) {
  const rows = log.map((r, i) => ({ ...r, i, iso: isoOf(r.date) }));
  const from = rows.reduce((m, r) => (r.iso < m ? r.iso : m), '9999');
  const inWindow = debits.filter(t => t.date >= from);
  const used = new Set(rows.filter(r => r.txId).map(r => r.txId));
  const taken = new Set();
  const out = { stamp: [], add: [], skip: [], emailOnly: [], from };

  for (const t of inWindow.sort((a, b) => a.date.localeCompare(b.date))) {
    if (used.has(t.id)) continue;                                  // already stamped
    if (SKIP.some(s => t.merchant.includes(s))) { out.skip.push(t); continue; }
    const cands = rows
      .filter(r => !taken.has(r.i) && !r.txId && Math.abs(r.amt - t.amt) < 0.005 && dayGap(r.iso, t.date) <= DATE_SLACK)
      .sort((a, b) => dayGap(a.iso, t.date) - dayGap(b.iso, t.date));
    if (cands.length) { taken.add(cands[0].i); out.stamp.push({ row: cands[0], tx: t }); continue; }
    const m = matchDebit(t.merchant, t.amt, userBills, dow(t.date));
    out.add.push({ tx: t, entry: {
      merchant: t.merchant, amt: t.amt, date: usaaOf(t.date), txId: t.id, src: 'plaid',
      status: m.bill ? 'matched' : 'discretionary',
      ...(m.bill ? { bill: m.bill, label: m.label } : {}),
      ...(m.status === 'pending' && !m.bill ? { unmatched: true } : {}),
    } });
  }
  out.emailOnly = rows.filter(r => !taken.has(r.i) && !r.txId);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = await (await dbFetch('app_config')).json();
  const st = await (await dbFetch(`hft/${cfg.dataSecret}/state`)).json();
  const log = (st.debitLog || []).filter(Boolean);
  const r = reconcile(log, await plaidDebits(), st.userBills || [], loadMatcher());
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0).toFixed(2);

  console.log(`DRY RUN — nothing written.  debitLog n=${log.length}, window from ${r.from}\n`);
  console.log(`  stamp  ${r.stamp.length}   email rows Plaid confirms (get txId, no other change)`);
  console.log(`  add    ${r.add.length}   Plaid debits no email row covers   $${sum(r.add, x => x.tx.amt)}`);
  for (const a of r.add) console.log(`         ${a.tx.date}  $${String(a.tx.amt).padStart(8)}  ${a.entry.status.padEnd(13)} ${(a.entry.bill || '').padEnd(12)} ${a.tx.merchant.slice(0, 44)}`);
  console.log(`  skip   ${r.skip.length}   transfers/checks/fees   $${sum(r.skip, x => x.amt)}`);
  console.log(`  email-only ${r.emailOnly.length}   email rows with no Plaid twin (kept as-is)`);
  for (const e of r.emailOnly) console.log(`         ${e.iso}  $${String(e.amt).padStart(8)}  ${e.status.padEnd(13)} ${e.merchant.slice(0, 44)}`);
  const pend = log.filter(d => d.status === 'pending');
  console.log(`\n  existing 'pending' rows: ${pend.length}  ($${sum(pend, d => d.amt)}) — under the no-review rule these become discretionary`);
}
