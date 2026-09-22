// Derive the live balance from Gmail, and MEASURE how well it tracks reality.
//
//   node tools/balance/report.mjs [--days 35] [--account 4496]
//
// Prints three things, in this order, because the later ones are worthless if the
// earlier ones fail:
//   1. INSTRUMENT CHECK — prove the enumeration is complete before believing anything
//      it returns. Every thread is expanded with `users.threads.get`, which does not
//      depend on the query, and any message `users.messages.list` left out is fetched
//      and inspected: if it is a USAA alert inside the window, paging lost it and the
//      run ABORTS. Counts alone would prove nothing, since a thread legitimately holds
//      messages older than the window.
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
// A silent transport is not a working transport, and "it returned some messages" is
// not proof it returned all of them — the thread-search bug looked exactly like
// success. So test against a KNOWN POSITIVE: expand every thread with `threads.get`,
// which is independent of the query, and check that message-level paging lost none of
// the messages that genuinely belong in the window.
//
// Comparing raw counts would be wrong: a thread legitimately holds messages OLDER than
// the window, which `q` excludes. So each extra id is fetched and only counted as a
// miss if it is a USAA alert dated inside the window — i.e. something `list` should
// have returned and did not.
const byThread = new Map();
for (const { id, threadId } of ids) {
  if (!byThread.has(threadId)) byThread.set(threadId, []);
  byThread.get(threadId).push(id);
}
// A DAY OF SLACK, deliberately. Gmail's `newer_than:Nd` is day-granular and fuzzy at
// the edge, but this cutoff is exact to the millisecond — so a message from ~34.9 days
// ago that Gmail excluded from `list` and `threads.get` still returns would be scored
// as MISSED and abort the run with nothing actually wrong. The check must only fire on
// a message the query plainly should have caught.
const cutoff = Date.now() - (days - 1) * 86400e3;
const ALERT_SUBJ = /available balance|debit alert|deposit to your bank/i;
let missed = 0, extrasChecked = 0, biggest = { total: 0 };
for (const [tid, got] of byThread) {
  const all = await threadMessageIds(tid);
  if (all.length > biggest.total) biggest = { tid, total: all.length, got: got.length };
  const extras = all.filter(x => !got.includes(x));
  if (!extras.length) continue;
  for (const m of await getMessages(extras)) {
    extrasChecked++;
    if (Number(m.internalDate) >= cutoff && ALERT_SUBJ.test(m.subject) && /usaa/i.test(m.from)) {
      missed++;
      console.log(`  MISSED by messages.list: ${new Date(Number(m.internalDate)).toISOString().slice(0, 16)}  ${m.subject}`);
    }
  }
}
console.log(`instrument: ${ids.length} ids over ${byThread.size} threads; largest thread holds `
  + `${biggest.total} messages (list returned ${biggest.got} — the rest are older than the window)`);
console.log(`  cross-checked ${extrasChecked} out-of-set messages via threads.get: ${missed} in-window alerts missed`);
if (missed) {
  console.log('  ABORT: the enumeration is incomplete, so every number below is wrong by');
  console.log('  at least those events. Fix the transport before reading further.');
  process.exit(3);
}
console.log('  enumeration proven complete for this window.\n');

// ── 2. parse ────────────────────────────────────────────────────────────────────
process.stdout.write('fetching bodies: ');
const msgs = await getMessages(ids, { onProgress: (d, n) => { if (d % 25 === 0 || d === n) process.stdout.write(`${d}/${n} `); } });
console.log('');
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
