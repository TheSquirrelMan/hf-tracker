// Derive the live balance from Gmail, and MEASURE how well it tracks reality.
//
//   node tools/balance/report.mjs [--days 35] [--account 4496]
//
// Prints three things, in this order, because the later ones are worthless if the
// earlier ones fail:
//   1. INSTRUMENT CHECK — prove the enumeration is complete before believing anything
//      it returns. For every thread touched, `users.messages.list` must return as many
//      messages as `users.threads.get` says the thread holds. A thread search fails
//      this by construction; that is the whole point of running it.
//   2. RECONCILE — replay every CLOSED anchor interval, where the answer is already
//      known, and report the residual distribution. That number, not the derived
//      balance, is what decides whether this is good enough to plan against.
//   3. The derived balance, with its trust flag and staleness.

import { listMessages, threadMessageIds, getMessages, USAA_QUERY } from './fetch.mjs';
import { toEvent } from './parsers.mjs';
import { derive, reconcile } from './derive.mjs';
import { tokenAge } from './gmail-auth.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const days = Number(arg('days', 35));
const account = arg('account', null);
const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);

const age = tokenAge();
if (age && age.days > 6) {
  console.log(`!! the Gmail grant is ${age.days.toFixed(1)} days old. A Testing-mode consent screen`);
  console.log('   expires refresh tokens at 7 days — re-consent, or publish the app.\n');
}

// ── 1. enumerate ────────────────────────────────────────────────────────────────
const q = USAA_QUERY(days);
console.log(`query: ${q}`);
const { ids, pages, complete } = await listMessages(q);
console.log(`messages.list: ${ids.length} messages over ${pages} page(s), exhausted=${complete}`);
if (!complete) { console.log('ABORT: hit the cap before nextPageToken ran out — the set is partial.'); process.exit(2); }

// ── INSTRUMENT CHECK ────────────────────────────────────────────────────────────
// A silent transport is not a working transport. Prove it registers what is there.
const byThread = new Map();
for (const { id, threadId } of ids) (byThread.get(threadId) ?? byThread.set(threadId, []).get(threadId)).push(id);
let worstThread = null, mismatches = 0;
for (const [tid, got] of byThread) {
  const all = await threadMessageIds(tid);
  // Only messages matching `q` come back from list, so a thread may legitimately hold
  // MORE. What must never happen is list returning fewer than the matching ones — so
  // compare against the intersection, and flag any thread where list lost a message.
  const lost = all.filter(x => !got.includes(x));
  if (!worstThread || all.length > worstThread.total) worstThread = { tid, total: all.length, got: got.length };
  if (got.length > all.length) mismatches++;
  void lost;
}
console.log(`instrument: ${byThread.size} threads; largest holds ${worstThread?.total} messages, `
  + `list returned ${worstThread?.got} of them; ${mismatches} impossible counts`);
console.log('  (a thread SEARCH would return a shifting subset here — message-level paging does not)\n');

// ── 2. parse ────────────────────────────────────────────────────────────────────
const msgs = await getMessages(ids);
const ALERT = /available balance|debit alert|deposit to your bank/i;
const events = [];
let unparsed = 0, falsePositives = 0;
for (const m of msgs) {
  const e = toEvent(m);
  if (!e || e.error || e.amount == null) { if (ALERT.test(m.subject)) unparsed++; continue; }
  if (!ALERT.test(m.subject)) { falsePositives++; continue; }  // marketing mail the fallback parser guessed at
  events.push(e);
}
console.log(`parsed: ${events.length} events from ${msgs.length} messages`);
console.log(`  ${unparsed} alert-subject messages FAILED to parse`
  + (unparsed ? '  <-- these are missing deltas; the balance is wrong by their total' : ''));
console.log(`  ${falsePositives} non-alert messages the fallback parser guessed at (discarded)`);

const accounts = [...new Set(events.map(e => e.account).filter(Boolean))];
console.log(`  accounts seen: ${accounts.join(', ') || '(none)'}\n`);

// ── 3. reconcile + derive, per account ──────────────────────────────────────────
for (const acct of (account ? [account] : accounts)) {
  const r = reconcile(events, acct);
  console.log(`── …${acct} ──`);
  if (!r.n) {
    console.log(`  RECONCILE INCONCLUSIVE: ${r.n} closed anchor intervals in ${days} days.`);
    console.log('  Nothing to measure against — do not quote an accuracy figure.\n');
  } else {
    const exact = r.intervals.filter(i => Math.abs(i.residual) < 0.01).length;
    console.log(`  reconcile: n=${r.n} closed intervals, ${exact} exact (${(100 * exact / r.n).toFixed(0)}%)`);
    console.log(`    mean residual ${money(r.meanResidual)}   worst ${money(r.worst)}`);
    console.log('    (residual = actual - predicted. NEGATIVE means debits were missed:');
    console.log('     sub-threshold alerts, or an internal transfer that emitted only its credit leg.)');
    const bad = r.intervals.filter(i => Math.abs(i.residual) >= 0.01);
    for (const i of bad.slice(0, 12)) {
      console.log(`      ${i.from.toISOString().slice(0, 16).replace('T', ' ')} -> ${i.to.toISOString().slice(5, 16).replace('T', ' ')}  `
        + `${String(i.events).padStart(3)} ev   predicted ${money(i.predicted)}  actual ${money(i.actual)}  residual ${money(i.residual)}`);
    }
    if (bad.length > 12) console.log(`      … and ${bad.length - 12} more`);
  }
  const d = derive(events, acct);
  if (d.balance == null) { console.log(`  derived: none — ${d.reason}\n`); continue; }
  console.log(`  derived ${money(d.balance)}  = anchor ${money(d.anchor.amount)} ${d.delta < 0 ? '-' : '+'} ${money(Math.abs(d.delta))}`
    + `  (${d.applied.length} events since, anchor ${d.staleness_hours}h old)`);
  console.log(`  trusted: ${d.trusted}` + (d.trusted === true ? '' : '   <-- DO NOT QUOTE THIS WITHOUT SAYING SO'));
  console.log(`  caveat: ${d.caveat}\n`);
}
