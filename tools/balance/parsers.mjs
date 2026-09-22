// Parsers for USAA alert emails -> structured events.
//
// Pure functions: plain-text body in, event out. No network, no Gmail, no state — so
// they are unit-testable against fixtures and the transport can be swapped later.
//
// Every parser returns null when it does not recognise the body. It NEVER guesses:
// a body it half-understands is a null plus a reason, because a wrong amount silently
// applied to a balance is worse than no amount at all.
//
// Format note, learned from real mail: USAA emits the SAME alert with two different
// separators — blank lines ("To:\n\nTMOBILE PO") and tabs ("To:\n\tCAPITAL ONE CRCARDPMT").
// Every label pattern below therefore uses \s* and must not assume newlines.

const money = /\$([0-9][0-9,]*\.\d{2})/;
const num = s => Number(String(s).replace(/[$,]/g, ''));

/** "...4496" / "ending in 4496" / "ending in: 3290" -> "4496" */
const last4 = s => (String(s).match(/(\d{4})\s*$/) || [])[1] || null;

/**
 * Available Balance for Your Account — the ANCHOR.
 * One email PER ACCOUNT (checking ~13:50, savings ~14:40), not two of the same.
 */
export function parseBalance(body) {
  if (!body) return null;
  // Two independent statements of the same fact — parse both and require agreement.
  const lead = body.match(/You have\s+\$([0-9][0-9,]*\.\d{2})\s+available in your account\s+\.*(\d{4})/i);
  const acct = body.match(/Account number:\s*\.*\s*(\d{4})/i);
  const bal = body.match(/Available balance:\s*\$([0-9][0-9,]*\.\d{2})/i);
  if (!lead && !(acct && bal)) return null;

  const account = (acct && acct[1]) || (lead && lead[2]) || null;
  const amount = bal ? num(bal[1]) : lead ? num(lead[1]) : null;
  if (!account || amount == null) return null;

  // Cross-check: if both forms are present they must agree, or we refuse.
  if (lead && bal && num(lead[1]) !== amount) {
    return { kind: 'balance', error: 'lead/label amount disagree', account, amount: null };
  }
  if (lead && acct && lead[2] !== account) {
    return { kind: 'balance', error: 'lead/label account disagree', account: null, amount };
  }
  return { kind: 'balance', account, amount, sign: 0 };
}

/** Debit Alert — money OUT. Threshold-gated by USAA: small debits never arrive. */
export function parseDebit(body) {
  if (!body) return null;
  const lead = body.match(/\$([0-9][0-9,]*\.\d{2})\s+came out of your account ending in\s+(\d{4})/i);
  if (!lead) return null;
  const merchant = (body.match(/To:\s*([^\n\r\t]+)/i) || [])[1];
  const date = (body.match(/Date:\s*(\d{2}\/\d{2}\/\d{2,4})/i) || [])[1];
  return {
    kind: 'debit',
    account: lead[2],
    amount: num(lead[1]),
    sign: -1,
    merchant: merchant ? merchant.trim() : null,
    date: date || null,
  };
}

/** Deposit to Your Bank Account — money IN. Includes transfers, refunds, payroll. */
export function parseDeposit(body) {
  if (!body) return null;
  const lead = body.match(/You received a deposit of\s+\$([0-9][0-9,]*\.\d{2})\s+to your account\s+\.*(\d{4})/i);
  if (!lead) return null;
  const amt = body.match(/Amount:\s*\$([0-9][0-9,]*\.\d{2})/i);
  if (amt && num(amt[1]) !== num(lead[1])) {
    return { kind: 'deposit', error: 'lead/label amount disagree', account: lead[2], amount: null };
  }
  const from = (body.match(/From:\s*([^\n\r\t]+)/i) || [])[1];
  const date = (body.match(/Date:\s*(\d{2}\/\d{2}\/\d{2,4})/i) || [])[1];
  return {
    kind: 'deposit',
    account: lead[2],
    amount: num(lead[1]),
    sign: +1,
    source: from ? from.trim() : null,
    date: date || null,
  };
}

/** Route by subject, fall back to sniffing the body. */
export function parseAlert({ subject = '', body = '' } = {}) {
  const s = subject.toLowerCase();
  if (s.includes('available balance')) return parseBalance(body);
  if (s.includes('debit alert')) return parseDebit(body);
  if (s.includes('deposit to your bank')) return parseDeposit(body);
  return parseBalance(body) || parseDeposit(body) || parseDebit(body);
}

/**
 * Build an event from a Gmail message.
 *
 * TIMEZONE TRAP, learned the hard way: Gmail's `date` is ISO with a trailing Z (UTC)
 * and `internalDate` is epoch-ms. Parsing "2026-09-22T11:35:21" WITHOUT the Z makes
 * JS read it as LOCAL time, shifting it +4h in America/New_York — which pushes the
 * newest events past `asOf` so derive() silently drops them and the balance reads high.
 * Always go through internalDate (unambiguous), or keep the Z.
 *
 * @param {{internalDate?:string|number, date?:string, subject?:string, body?:string}} msg
 */
export function toEvent(msg = {}) {
  const e = parseAlert(msg);
  if (!e) return null;
  let at = null;
  if (msg.internalDate != null) at = new Date(Number(msg.internalDate));
  else if (msg.date) at = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(msg.date) ? msg.date : msg.date + 'Z');
  if (!at || isNaN(at)) return { ...e, at: null, error: e.error || 'unparseable timestamp' };
  return { ...e, at };
}

export const _internal = { money, num, last4 };
