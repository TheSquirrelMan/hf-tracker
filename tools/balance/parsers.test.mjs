// node --test tools/balance/parsers.test.mjs
//
// Fixtures are real USAA email STRUCTURE with the amounts and account numbers changed.
// This repo is public — never paste a real balance into a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance, parseDebit, parseDeposit, parseAlert } from './parsers.mjs';
import { derive, reconcile } from './derive.mjs';

// ── real formats, redacted ────────────────────────────────────────────────────
const BALANCE = `USAA SECURITY ZONE Jonathan USAA # ending in: 0000 You have $1,234.56 available in your account ...1111.


Account number:

...1111

Available balance:

$1,234.56



Check Your Account`;

// variant A — blank-line separators
const DEBIT_BLANKLINE = `USAA SECURITY ZONE Hi, Jonathan.

$10.00 came out of your account ending in 1111.


To:

SOME MERCHANT PO

Date:

09/22/26`;

// variant B — TAB separators. Same alert, different layout. This is the one that
// breaks a regex written against only variant A.
const DEBIT_TAB = `USAA SECURITY ZONE Hi, Jonathan.

$25.00 came out of your account ending in 1111.

To:
\tOTHER MERCHANT PMT
Date:
\t09/22/26
Check My Account`;

const DEPOSIT = `USAA SECURITY ZONE You received a deposit of $500.00 to your account ...1111.


From:

SOME TRANSFER CR

To:

...1111

Date:

09/21/26

Amount:

$500.00`;

test('balance: parses account and amount', () => {
  const e = parseBalance(BALANCE);
  assert.equal(e.kind, 'balance');
  assert.equal(e.account, '1111');
  assert.equal(e.amount, 1234.56);
});

test('debit: blank-line separators', () => {
  const e = parseDebit(DEBIT_BLANKLINE);
  assert.equal(e.kind, 'debit');
  assert.equal(e.amount, 10);
  assert.equal(e.sign, -1);
  assert.equal(e.account, '1111');
  assert.equal(e.merchant, 'SOME MERCHANT PO');
  assert.equal(e.date, '09/22/26');
});

test('debit: TAB separators parse identically', () => {
  const e = parseDebit(DEBIT_TAB);
  assert.equal(e.amount, 25);
  assert.equal(e.merchant, 'OTHER MERCHANT PMT');
  assert.equal(e.date, '09/22/26');
});

test('deposit: positive sign and source', () => {
  const e = parseDeposit(DEPOSIT);
  assert.equal(e.kind, 'deposit');
  assert.equal(e.amount, 500);
  assert.equal(e.sign, +1);
  assert.equal(e.source, 'SOME TRANSFER CR');
});

test('refuses to guess: unrecognised body returns null', () => {
  assert.equal(parseBalance('hello world'), null);
  assert.equal(parseDebit('hello world'), null);
  assert.equal(parseDeposit('hello world'), null);
});

test('refuses to guess: disagreeing amounts are flagged, not averaged', () => {
  const bad = DEPOSIT.replace('Amount:\n\n$500.00', 'Amount:\n\n$999.00');
  const e = parseDeposit(bad);
  assert.equal(e.amount, null);
  assert.match(e.error, /disagree/);
});

test('routing by subject', () => {
  assert.equal(parseAlert({ subject: 'Debit Alert for Your USAA Bank Account', body: DEBIT_TAB }).kind, 'debit');
  assert.equal(parseAlert({ subject: 'Available Balance for Your Account', body: BALANCE }).kind, 'balance');
  assert.equal(parseAlert({ subject: 'Deposit to Your Bank Account', body: DEPOSIT }).kind, 'deposit');
});

// ── derivation ────────────────────────────────────────────────────────────────
const at = s => new Date(s);
const ev = (o, when) => ({ ...o, at: at(when) });

test('derive: anchor plus deltas', () => {
  const events = [
    ev(parseBalance(BALANCE), '2026-09-21T13:56:00'),            // 1234.56
    ev(parseDeposit(DEPOSIT), '2026-09-21T19:51:00'),            // +500
    ev(parseDebit(DEBIT_TAB), '2026-09-22T08:02:00'),            // -25
    ev(parseDebit(DEBIT_BLANKLINE), '2026-09-22T08:58:00'),      // -10
  ];
  const r = derive(events, '1111', at('2026-09-22T09:30:00'));
  assert.equal(r.balance, 1699.56);
  assert.equal(r.delta, 465);
  assert.equal(r.applied.length, 3);
});

test('derive: a later anchor supersedes earlier deltas', () => {
  const later = { ...parseBalance(BALANCE), amount: 100 };
  const events = [
    ev(parseBalance(BALANCE), '2026-09-21T13:56:00'),
    ev(parseDebit(DEBIT_TAB), '2026-09-21T15:00:00'),
    ev(later, '2026-09-22T13:56:00'),                             // resets to 100
  ];
  const r = derive(events, '1111', at('2026-09-22T14:00:00'));
  assert.equal(r.balance, 100);
  assert.equal(r.delta, 0);
});

test('derive: no anchor -> null, never a guess', () => {
  const r = derive([ev(parseDebit(DEBIT_TAB), '2026-09-22T08:02:00')], '1111');
  assert.equal(r.balance, null);
  assert.equal(r.reason, 'no anchor');
});

test('derive: other accounts are ignored', () => {
  const other = { ...parseDebit(DEBIT_TAB), account: '9999' };
  const events = [
    ev(parseBalance(BALANCE), '2026-09-21T13:56:00'),
    ev(other, '2026-09-21T15:00:00'),
  ];
  assert.equal(derive(events, '1111', at('2026-09-21T16:00:00')).balance, 1234.56);
});

test('reconcile: measures the threshold gap instead of assuming it', () => {
  // Anchor 1000, one visible -$10 debit, next anchor says 985 -> $5 went unseen.
  const a1 = { ...parseBalance(BALANCE), amount: 1000 };
  const a2 = { ...parseBalance(BALANCE), amount: 985 };
  const events = [
    ev(a1, '2026-09-21T13:56:00'),
    ev(parseDebit(DEBIT_BLANKLINE), '2026-09-21T18:00:00'),   // -10
    ev(a2, '2026-09-22T13:56:00'),
  ];
  const r = reconcile(events, '1111');
  assert.equal(r.n, 1);
  assert.equal(r.intervals[0].predicted, 990);
  assert.equal(r.intervals[0].actual, 985);
  assert.equal(r.intervals[0].residual, -5);      // negative = we missed debits
  assert.equal(r.meanResidual, -5);
});

// ── timestamps ────────────────────────────────────────────────────────────────
import { toEvent } from './parsers.mjs';

test('toEvent: internalDate (epoch ms) is unambiguous', () => {
  const e = toEvent({ internalDate: '1790076921000', subject: 'Debit Alert for Your USAA Bank Account', body: DEBIT_TAB });
  assert.equal(e.at.toISOString(), '2026-09-22T11:35:21.000Z');
});

test('toEvent: a Z-less date string is treated as UTC, not local', () => {
  // The bug this guards: parsing "...T11:35:21" as LOCAL shifts it +4h in New York,
  // pushing recent events past asOf so derive() drops them and the balance reads high.
  const e = toEvent({ date: '2026-09-22T11:35:21', subject: 'Debit Alert for Your USAA Bank Account', body: DEBIT_TAB });
  assert.equal(e.at.toISOString(), '2026-09-22T11:35:21.000Z');
});

test('toEvent: an explicit Z is respected', () => {
  const e = toEvent({ date: '2026-09-22T11:35:21Z', subject: 'Debit Alert for Your USAA Bank Account', body: DEBIT_TAB });
  assert.equal(e.at.toISOString(), '2026-09-22T11:35:21.000Z');
});

test('toEvent: the newest debit is NOT dropped by derive', () => {
  const events = [
    toEvent({ internalDate: String(Date.UTC(2026, 8, 21, 13, 56)), subject: 'Available Balance for Your Account', body: BALANCE }),
    toEvent({ internalDate: String(Date.UTC(2026, 8, 22, 11, 35)), subject: 'Debit Alert for Your USAA Bank Account', body: DEBIT_TAB }),
  ];
  const r = derive(events, '1111', new Date(Date.UTC(2026, 8, 22, 12, 0)));
  assert.equal(r.applied.length, 1);          // would be 0 under the local-parse bug
  assert.equal(r.balance, 1209.56);           // 1234.56 - 25
});

// ── gap detection: the fix for "a search silently returned fewer messages" ─────
test('derive: flags an incomplete fetch instead of reporting a wrong balance', () => {
  // Two anchors 1000 -> 800. Only a -$50 debit was fetched, so $150 went missing.
  const a1 = { ...parseBalance(BALANCE), amount: 1000 };
  const a2 = { ...parseBalance(BALANCE), amount: 800 };
  const d50 = { ...parseDebit(DEBIT_BLANKLINE), amount: 50 };
  const events = [
    ev(a1, '2026-09-20T13:56:00'),
    ev(d50, '2026-09-20T18:00:00'),
    ev(a2, '2026-09-21T13:56:00'),
    ev(d50, '2026-09-21T18:00:00'),
  ];
  const r = derive(events, '1111', at('2026-09-21T20:00:00'));
  assert.equal(r.balance, 750);
  assert.equal(r.trusted, false);                 // <- the whole point
  assert.equal(r.check.residual, -150);
  assert.match(r.check.reason, /missed ~\$150 of debits/);
});

test('derive: trusted when the previous interval reconciles exactly', () => {
  const a1 = { ...parseBalance(BALANCE), amount: 1000 };
  const a2 = { ...parseBalance(BALANCE), amount: 950 };
  const d50 = { ...parseDebit(DEBIT_BLANKLINE), amount: 50 };
  const events = [
    ev(a1, '2026-09-20T13:56:00'),
    ev(d50, '2026-09-20T18:00:00'),
    ev(a2, '2026-09-21T13:56:00'),
  ];
  const r = derive(events, '1111', at('2026-09-21T14:00:00'));
  assert.equal(r.trusted, true);
  assert.equal(r.check.residual, 0);
});

test('derive: a single anchor cannot be verified, so trusted is null not true', () => {
  const r = derive([ev(parseBalance(BALANCE), '2026-09-21T13:56:00')], '1111', at('2026-09-21T14:00:00'));
  assert.equal(r.trusted, null);
  assert.match(r.check.reason, /only one anchor/);
});

// REGRESSION, 2026-09-22: USAA sends the masked account with a Unicode ellipsis
// (U+2026) as often as with three ASCII dots. The parser only accepted dots, so 12 of
// 26 real deposit alerts in a 35-day window returned null and their money never reached
// the balance. Every masked-account pattern must accept both forms.
test('deposit: Unicode ellipsis account mask parses the same as ASCII dots', () => {
  const ascii = 'USAA SECURITY ZONE You received a deposit of $500.00 to your account ...1111.\nFrom:\tACME\nDate:\t09/22/26\nAmount:\t$500.00';
  const uni   = ascii.replace(/\.\.\./g, '\u2026');
  const a = parseDeposit(ascii), u = parseDeposit(uni);
  assert.equal(u?.amount, 500);
  assert.equal(u?.account, '1111');
  assert.deepEqual({ ...u, source: null }, { ...a, source: null });
});

test('balance: Unicode ellipsis account mask parses', () => {
  const e = parseBalance('USAA SECURITY ZONE You have $1,234.56 available in your account \u20261111.');
  assert.equal(e?.amount, 1234.56);
  assert.equal(e?.account, '1111');
});
