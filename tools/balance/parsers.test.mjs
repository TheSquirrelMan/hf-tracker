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
