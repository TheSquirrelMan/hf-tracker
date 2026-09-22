// Derive a current balance from an anchor plus the deltas that followed it.
//
//   balance_now = last_balance_email - debits_since + deposits_since
//
// The anchor is authoritative and arrives twice a day (one email per account), so
// error can never accumulate beyond one anchor interval — the next anchor resets it
// to zero. That is the whole reason this works without an API.
//
// KNOWN GAP, do not hide it: USAA debit alerts are threshold-gated ("a debit over a
// certain amount"), so sub-threshold debits are invisible and the derived balance
// reads HIGH until the next anchor. `reconcile()` measures exactly that, so the cost
// of the threshold is reported rather than assumed.

/**
 * @param {Array} events  parsed alerts, each {kind, account, amount, sign, at:Date}
 * @param {string} account  last-4, e.g. "4496"
 * @param {Date} [asOf]     defaults to now
 */
export function derive(events, account, asOf = new Date()) {
  const mine = events
    .filter(e => e && e.account === account && e.amount != null && !e.error)
    .filter(e => e.at instanceof Date && !isNaN(e.at) && e.at <= asOf)
    .sort((a, b) => a.at - b.at);

  // newest balance email at or before asOf
  let anchorIdx = -1;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].kind === 'balance') { anchorIdx = i; break; }
  }
  if (anchorIdx < 0) {
    return { account, balance: null, reason: 'no anchor', anchor: null, applied: [] };
  }

  const anchor = mine[anchorIdx];
  const applied = mine.slice(anchorIdx + 1).filter(e => e.kind !== 'balance');
  const delta = applied.reduce((a, e) => a + e.sign * e.amount, 0);

  // SELF-CHECK. Any enumeration can miss messages — Gmail thread search demonstrably
  // does — so never present a derived balance as trustworthy without testing the
  // fetch against the last CLOSED anchor interval, where the answer is already known.
  // A non-zero residual there means events were missed and this balance is wrong by
  // at least that much. Detection beats trusting the transport.
  const check = lastIntervalResidual(mine, anchorIdx);

  return {
    account,
    balance: Math.round((anchor.amount + delta) * 100) / 100,
    anchor: { amount: anchor.amount, at: anchor.at },
    delta: Math.round(delta * 100) / 100,
    applied,
    staleness_hours: Math.round(((asOf - anchor.at) / 36e5) * 10) / 10,
    // trusted only when the previous interval reconciled exactly
    trusted: check.residual === null ? null : Math.abs(check.residual) < 0.01,
    check,
    // honest about what it cannot see
    caveat: 'debit alerts fire on POSTING; pending holds are not reflected',
  };
}

/**
 * Residual across the most recent CLOSED interval (the two anchors before `anchorIdx`).
 * null when there is no earlier anchor to close an interval against.
 */
function lastIntervalResidual(sorted, anchorIdx) {
  let prevIdx = -1;
  for (let i = anchorIdx - 1; i >= 0; i--) {
    if (sorted[i].kind === 'balance') { prevIdx = i; break; }
  }
  if (prevIdx < 0) return { residual: null, reason: 'only one anchor — nothing to verify against' };
  const prev = sorted[prevIdx], cur = sorted[anchorIdx];
  const between = sorted.slice(prevIdx + 1, anchorIdx).filter(e => e.kind !== 'balance');
  const predicted = prev.amount + between.reduce((a, e) => a + e.sign * e.amount, 0);
  const residual = Math.round((cur.amount - predicted) * 100) / 100;
  return {
    residual,
    predicted: Math.round(predicted * 100) / 100,
    actual: cur.amount,
    events: between.length,
    from: prev.at, to: cur.at,
    reason: residual === 0 ? 'reconciled exactly'
      : residual < 0 ? `missed ~$${Math.abs(residual)} of debits in the previous interval`
      : `missed ~$${residual} of credits in the previous interval`,
  };
}

/**
 * Compare what we PREDICTED for an anchor against what that anchor actually said.
 * The residual is the cost of the threshold gap (plus any missed event type).
 * Run this every cycle — it turns an unknown into a measured number.
 */
export function reconcile(events, account) {
  const mine = events
    .filter(e => e && e.account === account && e.amount != null && !e.error)
    .filter(e => e.at instanceof Date && !isNaN(e.at))
    .sort((a, b) => a.at - b.at);

  const anchors = mine.map((e, i) => [e, i]).filter(([e]) => e.kind === 'balance');
  const out = [];
  for (let k = 1; k < anchors.length; k++) {
    const [prev, pi] = anchors[k - 1];
    const [cur, ci] = anchors[k];
    const between = mine.slice(pi + 1, ci).filter(e => e.kind !== 'balance');
    const predicted = prev.amount + between.reduce((a, e) => a + e.sign * e.amount, 0);
    out.push({
      from: prev.at, to: cur.at,
      predicted: Math.round(predicted * 100) / 100,
      actual: cur.amount,
      residual: Math.round((cur.amount - predicted) * 100) / 100,
      events: between.length,
    });
  }
  const res = out.map(o => o.residual);
  return {
    account,
    intervals: out,
    n: out.length,
    // a negative mean residual means we are systematically MISSING debits
    meanResidual: res.length ? Math.round((res.reduce((a, b) => a + b, 0) / res.length) * 100) / 100 : null,
    worst: res.length ? res.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0) : null,
  };
}
