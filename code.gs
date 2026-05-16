// ── USAA Alerts → Firebase Sync + Notifications ──
// Google Apps Script — script.google.com

const DB_ROOT = "https://hf-tracker-81e76-default-rtdb.firebaseio.com";
let FIREBASE_BASE = "";

const USAA_SENDER = "USAA.customer.service@mailcenter.usaa.com";
const NOTIFY_EMAIL = "2densuke@gmail.com";

const BALANCE_LABEL   = "usaa-balance-synced";
const KAREN_PAY_LABEL = "usaa-karen-pay-synced";
const JON_PAY_LABEL   = "usaa-jon-pay-synced";
const DEBIT_LABEL     = "usaa-debit-synced";

// ── Default autoDisc keywords (pre-populated on first run if not in Firebase) ──
const DEFAULT_AUTO_DISC = [
  "PUBLIX",
  "STARBUCKS",
  "POLLOTROP",
  "MCDONALD",
  "WENDYS",
  "DRAGON TEA",
  "LONGHORN",
  "AMC ",
  "DD *DOORDASH",
  "CHICK-FIL-A",
  "CHIPOTLE",
  "FIVE GUYS",
  "TACO BELL",
];

function initFirebasePath() {
  const dataSecret = PropertiesService.getScriptProperties().getProperty('DATA_SECRET');
  if (!dataSecret) throw new Error('DATA_SECRET not set in Script Properties');
  FIREBASE_BASE = `${DB_ROOT}/hft/${dataSecret}/state`;
}

// ── Gmail REST helpers (message-level labeling) ──
function getLabelId(labelName) {
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true }
  );
  const data = JSON.parse(res.getContentText());
  Logger.log(`getLabelId response: ${res.getContentText().substring(0, 200)}`);
  if (!data || !data.labels) { Logger.log("No labels array in response"); return null; }
  const found = data.labels.find(l => l.name === labelName);
  return found ? found.id : null;
}

function labelMessage(msgId, labelId) {
  if (!labelId) { Logger.log(`labelMessage skipped — no labelId for msgId ${msgId}`); return; }
  const token = ScriptApp.getOAuthToken();
  UrlFetchApp.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`,
    {
      method: 'POST',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}` },
      payload: JSON.stringify({ addLabelIds: [labelId] }),
      muteHttpExceptions: true
    }
  );
}

function getMessageLabelIds(msgId) {
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=minimal`,
    { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true }
  );
  const data = JSON.parse(res.getContentText());
  return data.labelIds || [];
}

// ── 1. Daily balance sync (multi-account) ──
function syncUSAABalance() {
  initFirebasePath();
  const today = new Date();
  const dateStr = Utilities.formatDate(today, "America/New_York", "yyyy/MM/dd");
  const query = `from:${USAA_SENDER} subject:"Available Balance for Your Account" after:${dateStr}`;
  const threads = GmailApp.search(query, 0, 10);
  if (!threads.length) { Logger.log("No balance email found today."); return; }

  let label = GmailApp.getUserLabelByName(BALANCE_LABEL);
  if (!label) label = GmailApp.createLabel(BALANCE_LABEL);
  const labelId = getLabelId(BALANCE_LABEL);

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      const existingLabels = getMessageLabelIds(msgId);
      if (existingLabels.includes(labelId)) { Logger.log("Balance already synced."); continue; }

      const body = msg.getPlainBody();

      // Parse account number from email body
      // Pattern: "Account number: ...0725" or "...4496"
      const acctMatch = body.match(/Account number:\s*\n?\s*…?(\d{4})/);
      if (!acctMatch) { Logger.log("Could not parse account number."); continue; }
      const acctNum = acctMatch[1];
      Logger.log(`Found account: ${acctNum}`);

      // Parse available balance
      const balMatch = body.match(/Available balance:\s*\n?\s*\$([0-9,]+\.\d{2})/);
      if (!balMatch) { Logger.log("Could not parse balance."); continue; }
      const balance = parseFloat(balMatch[1].replace(/,/g, ""));
      Logger.log(`Balance parsed: $${balance} for account ${acctNum}`);

      // Write to the correct Firebase key based on account number
      const fbKey = acctNum === '4496' ? 'bal4496' : acctNum === '0725' ? 'bal0725' : null;
      if (!fbKey) { Logger.log(`Unknown account ${acctNum}, skipping.`); continue; }

      const res = firebasePut(`${FIREBASE_BASE}/${fbKey}.json`, balance);
      if (res === 200) {
        Logger.log(`✓ ${fbKey} updated: $${balance}`);
        labelMessage(msgId, labelId);
        
        // Low balance warning only for checking
        if (fbKey === 'bal4496' && balance < 500) {
          sendEmail(
            '⚠ HF Tracker — Low Balance',
            `#4496 balance is $${balance.toFixed(2)} — below $500.\n\nCheck the app.`
          );
        }
      }
    }
  }
}

// ── 2. Karen paycheck sync (Thursdays) ──
function syncKarenPay() {
  initFirebasePath();
  const today = new Date();
  const dateStr = Utilities.formatDate(today, "America/New_York", "yyyy/MM/dd");
  const query = `from:${USAA_SENDER} subject:"Deposit to Your Bank Account" after:${dateStr}`;
  const threads = GmailApp.search(query, 0, 10);
  if (!threads.length) return;

  let label = GmailApp.getUserLabelByName(KAREN_PAY_LABEL);
  if (!label) label = GmailApp.createLabel(KAREN_PAY_LABEL);
  const labelId = getLabelId(KAREN_PAY_LABEL);

  const state = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  const processedIds = state.processedPayIds || [];

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (processedIds.includes(msgId)) continue;
      const existingLabels = getMessageLabelIds(msgId);
      if (existingLabels.includes(labelId)) continue;

      const body = msg.getPlainBody();
      if (!body.toUpperCase().includes("COPANS MOTORS")) continue;

      const match = body.match(/Amount:[\s\S]*?\$([0-9,]+\.\d{2})/);
      if (!match) continue;
      const amount = parseFloat(match[1].replace(/,/g, ""));

      firebasePut(`${FIREBASE_BASE}/karenLastPay.json`, amount);
      firebasePut(`${FIREBASE_BASE}/karenLastPayDate.json`, Utilities.formatDate(today, "America/New_York", "yyyy-MM-dd"));
      const prevKarenAvg = state.karenAvgPay || amount;
      const newKarenAvg = Math.round((prevKarenAvg * 0.7) + (amount * 0.3));
      firebasePut(`${FIREBASE_BASE}/karenAvgPay.json`, newKarenAvg);
      processedIds.push(msgId);
      firebasePut(`${FIREBASE_BASE}/processedPayIds.json`, processedIds);
      labelMessage(msgId, labelId);
      Logger.log(`✓ karenLastPay updated: $${amount}, karenAvgPay: $${newKarenAvg}`);
      const currentBal = firebaseGet(`${FIREBASE_BASE}/bal4496.json`) || 0;
      sendSnowballReminder(currentBal, `Karen's pay of $${amount.toFixed(2)} just landed`);
    }
  }
}

// ── 3. Jon paycheck sync (7th and 22nd) ──
function syncJonPay() {
  initFirebasePath();
  const today = new Date();
  const dayOfMonth = today.getDate();
  if (dayOfMonth !== 7 && dayOfMonth !== 22) return;

  const dateStr = Utilities.formatDate(today, "America/New_York", "yyyy/MM/dd");
  const query = `from:${USAA_SENDER} subject:"Deposit to Your Bank Account" after:${dateStr}`;
  const threads = GmailApp.search(query, 0, 10);
  if (!threads.length) return;

  let label = GmailApp.getUserLabelByName(JON_PAY_LABEL);
  if (!label) label = GmailApp.createLabel(JON_PAY_LABEL);
  const labelId = getLabelId(JON_PAY_LABEL);

  const state = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  const processedIds = state.processedPayIds || [];

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (processedIds.includes(msgId)) continue;
      const existingLabels = getMessageLabelIds(msgId);
      if (existingLabels.includes(labelId)) continue;

      const body = msg.getPlainBody();
      if (!body.toUpperCase().includes("APPLIED BEHAVIOR")) continue;

      const match = body.match(/Amount:[\s\S]*?\$([0-9,]+\.\d{2})/);
      if (!match) continue;
      const amount = parseFloat(match[1].replace(/,/g, ""));

      firebasePut(`${FIREBASE_BASE}/jonLastPay.json`, amount);
      const prevAvg = state.jonAvgPay || amount;
      const newAvg = Math.round((prevAvg * 0.7) + (amount * 0.3));
      firebasePut(`${FIREBASE_BASE}/jonAvgPay.json`, newAvg);
      processedIds.push(msgId);
      firebasePut(`${FIREBASE_BASE}/processedPayIds.json`, processedIds);
      labelMessage(msgId, labelId);
      Logger.log(`✓ jonLastPay updated: $${amount}`);
      const currentBal = firebaseGet(`${FIREBASE_BASE}/bal4496.json`) || 0;
      sendSnowballReminder(currentBal, `Jon's pay of $${amount.toFixed(2)} just landed`);
    }
  }
}

// ── 4. Daily milestone check ──
// Reads cardBals from Firebase — no hardcoded targets
function checkMilestones() {
  initFirebasePath();
  const state = firebaseGet(`${FIREBASE_BASE}.json`);
  if (!state) return;

  const cardBals  = state.cardBals  || {};
  const notified  = state.notified  || {};
  const userBills = state.userBills || [];
  let   updated   = false;
  const today     = Utilities.formatDate(new Date(), "America/New_York", "yyyy-MM-dd");

  // Build targets from userBills that have a cardId (debt bills)
  // Each unique cardId represents a debt that can be paid off
  const seen = new Set();
  const targets = [];
  userBills.forEach(b => {
    if (b.cardId && !seen.has(b.cardId)) {
      seen.add(b.cardId);
      targets.push({ id: b.cardId, label: b.name });
    }
  });

  targets.forEach((target, i) => {
    const currentBal = cardBals[target.id];
    if (currentBal === undefined || currentBal === null) return;

    const notifyKey = `paid-off-${target.id}`;
    if (currentBal <= 0 && !notified[notifyKey]) {
      const nextTarget = targets.slice(i + 1).find(t => (cardBals[t.id] || 0) > 0);
      sendEmail(
        `🎉 HF Tracker — ${target.label} Paid Off!`,
        `${target.label} is fully paid off.\n\n` +
        (nextTarget
          ? `Next target: ${nextTarget.label}`
          : `All debts are paid off. Completely debt free! 🎉`)
      );
      notified[notifyKey] = today;
      updated = true;
    }
  });

  if (updated) firebasePut(`${FIREBASE_BASE}/notified.json`, notified);
}

// ── Snowball reminder helper ──
// Reads phases and targets from Firebase state
function sendSnowballReminder(currentBal, context) {
  const state = firebaseGet(`${FIREBASE_BASE}.json`);
  if (!state) return;

  const phaseDone  = state.phaseDone  || {};
  const cardBals   = state.cardBals   || {};
  const userBills  = state.userBills  || [];
  const phases     = state.phases     || [];
  const phaseCosts = state.phaseCosts || {};

  const phasesWithCosts = phases.map(p => ({
    ...p,
    cost: phaseCosts[p.id] !== undefined ? phaseCosts[p.id] : p.cost
  }));

  const allPhasesDone = phasesWithCosts.every(p => phaseDone[p.id]);

  if (!allPhasesDone) {
    const nextPhase = phasesWithCosts.find(p => !phaseDone[p.id]);
    if (nextPhase) {
      sendEmail(
        '💰 HF Tracker — Paycheck Landed',
        `${context}\n\nCurrent #4496 balance: $${currentBal.toFixed(2)}\n\n` +
        `You are saving for: ${nextPhase.label} ($${nextPhase.cost.toLocaleString()})\n\nDo nothing — leave the money in #4496.`
      );
    }
    return;
  }

  // Build debt targets from userBills with cardId
  const seen = new Set();
  const targets = [];
  userBills.forEach(b => {
    if (b.cardId && !seen.has(b.cardId)) {
      seen.add(b.cardId);
      targets.push({ id: b.cardId, label: b.name, amt: b.amt });
    }
  });

  const target = targets.find(t => (cardBals[t.id] || 0) > 0);
  if (!target) return;

  const targetBal = cardBals[target.id] || 0;
  const payAmt = Math.max(0, Math.min(targetBal, currentBal - 800));

  sendEmail(
    `💸 HF Tracker — Pay $${Math.round(payAmt).toLocaleString()} to ${target.label}`,
    `${context}\n\nCurrent #4496 balance: $${currentBal.toFixed(2)}\n\n` +
    `Active snowball target: ${target.label}\nRemaining balance: $${Math.round(targetBal).toLocaleString()}\n\n` +
    `ACTION REQUIRED:\nMake a payment of $${Math.round(payAmt).toLocaleString()} right now.\n\n` +
    `Open the app: https://hf-tracker.netlify.app`
  );
}

// ── Debit sync ──
function syncUSAADebits() {
  initFirebasePath();

  const since   = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
  const dateStr = Utilities.formatDate(since, "America/New_York", "yyyy/MM/dd");
  const query   = `from:${USAA_SENDER} subject:"Debit Alert" after:${dateStr}`;
  const threads = GmailApp.search(query, 0, 30);
  if (!threads.length) { Logger.log("No debit alert emails found."); return; }

  let label = GmailApp.getUserLabelByName(DEBIT_LABEL);
  if (!label) label = GmailApp.createLabel(DEBIT_LABEL);
  const labelId = getLabelId(DEBIT_LABEL);

  const state      = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  let   autoDisc   = state.autoDisc    || DEFAULT_AUTO_DISC;
  let   debitLog   = state.debitLog    || [];
  let   discLog    = state.discLog     || [];
  let   discSpent  = state.discSpent   || 0;
  const userBills  = state.userBills   || [];
  let   changed    = false;
  let   newPending = 0;

  if (!state.autoDisc) {
    firebasePut(`${FIREBASE_BASE}/autoDisc.json`, DEFAULT_AUTO_DISC);
    Logger.log("Seeded default autoDisc keywords to Firebase");
  }

  const processedIds = state.processedMsgIds || [];

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (processedIds.includes(msgId)) continue;

      const body = msg.getPlainBody();

      if (!body.includes("came out of your account ending in 4496")) {
        labelMessage(msgId, labelId);
        continue;
      }

      const amtMatch = body.match(/\$([0-9,]+\.\d{2})\s+came out/);
      if (!amtMatch) { Logger.log("Could not parse amount"); continue; }
      const amt = parseFloat(amtMatch[1].replace(/,/g, ""));

      const merchantMatch = body.match(/To:\s*\n?\s*([^\n\r]+)/);
      if (!merchantMatch) { Logger.log("Could not parse merchant"); continue; }
      const merchant = merchantMatch[1].trim().toUpperCase().replace(/\s+/g, " ");

      const dateMatch = body.match(/Date:\s*\n?\s*(\d{2}\/\d{2}\/\d{2})/);
      const txDate    = dateMatch
        ? formatUsaaDate(dateMatch[1])
        : Utilities.formatDate(new Date(), "America/New_York", "M/d/yyyy");
      const txDow = msg.getDate().getDay();

      Logger.log(`Parsed: ${merchant} | $${amt} | ${txDate} | DOW:${txDow}`);

      const isDupe = debitLog.some(d =>
        d.merchant === merchant && Math.abs(d.amt - amt) < 0.01 && d.date === txDate
      );
      if (isDupe) {
        Logger.log(`Skipped duplicate: ${merchant} $${amt}`);
        labelMessage(msgId, labelId);
        continue;
      }

      if (
        merchant.includes("CHECK #") ||
        merchant.includes("OD FEE") ||
        merchant.includes("USAA FUNDS TRANSFER")
      ) {
        Logger.log(`Skipped (ignored type): ${merchant}`);
        labelMessage(msgId, labelId);
        continue;
      }

      const result = matchDebit(merchant, amt, autoDisc, userBills, txDow);
      Logger.log(`Match: ${result.status}${result.bill ? " → " + result.bill : ""}`);

      const entry = { merchant, amt, date: txDate, ts: new Date().getTime(), status: result.status };
      if (result.bill)  entry.bill  = result.bill;
      if (result.label) entry.label = result.label;
      debitLog.unshift(entry);

      if (result.status === "autoDisc") {
        const entryLabel = result.label || merchant;
        const txParts    = txDate.split("/");
        const txMillis   = new Date(parseInt(txParts[2]), parseInt(txParts[0])-1, parseInt(txParts[1])).getTime();
        const matchIdx   = discLog.findIndex(e => {
          if (e.auto) return false;
          const ep = (e.date||'').split('/');
          if (ep.length < 3) return false;
          const eMillis = new Date(parseInt(ep[2]),parseInt(ep[0])-1,parseInt(ep[1])).getTime();
          if (Math.abs(txMillis-eMillis)/86400000 > 2) return false;
          const el = (e.label||'').toUpperCase();
          const ml = entryLabel.toUpperCase();
          return el.includes(ml.split(' ')[0]) || ml.includes(el.split(' ')[0]);
        });
        if (matchIdx >= 0) {
          const old = discLog[matchIdx];
          discSpent = Math.max(0, discSpent - (old.amt||0));
          discLog[matchIdx] = {...old, amt, date: txDate, auto: true, confirmed: true};
          discSpent += amt;
        } else {
          discLog.unshift({ amt, date: txDate, label: entryLabel, cat: result.cat||'discretionary', auto: true });
          if (!result.cat || result.cat === 'discretionary') discSpent += amt;
        }
      }

      if (result.status === "pending") newPending++;
      processedIds.push(msgId);
      labelMessage(msgId, labelId);
      changed = true;
    }
  }

  if (changed) {
    const cutoff = new Date().getTime() - 90 * 24 * 60 * 60 * 1000;
    debitLog = debitLog.filter(d => !d.ts || d.ts > cutoff);
    firebasePut(`${FIREBASE_BASE}/debitLog.json`,        debitLog);
    firebasePut(`${FIREBASE_BASE}/discLog.json`,         discLog);
    firebasePut(`${FIREBASE_BASE}/discSpent.json`,       discSpent);
    firebasePut(`${FIREBASE_BASE}/processedMsgIds.json`, processedIds);
    Logger.log(`Done. debitLog: ${debitLog.length} entries, ${newPending} pending`);

    if (newPending > 0) {
      sendEmail(
        `📥 HF Tracker — ${newPending} unmatched transaction${newPending > 1 ? "s" : ""}`,
        `${newPending} debit${newPending > 1 ? "s" : ""} need categorization.\n\nOpen the app:\nhttps://hf-tracker.netlify.app`
      );
    }
  }
}

// ── Smart match logic ──
// Reads userBills from Firebase for keyword matching — no hardcoded bill lists
function matchDebit(merchant, amt, autoDisc, userBills, txDow) {

  // 1. AutoDisc keyword list
  for (const kw of autoDisc) {
    if (merchant.includes(kw.toUpperCase().trim())) {
      return { status: "autoDisc", label: merchant, cat: "discretionary" };
    }
  }

  // 2. PayPal Fresh Market: $150–$260, arrived Sun/Mon/Tue
  if (merchant.includes("PAYPAL")) {
    if (amt >= 150 && amt <= 260 && txDow >= 0 && txDow <= 2) {
      return { status: "autoDisc", label: "Fresh Market", cat: "groceries" };
    }
  }

  // 3. Match against userBills keywords from Firebase
  const billsWithKeywords = userBills.filter(b => b.keyword || b.debitKeyword);

  for (const bill of billsWithKeywords) {
    const keywords = (bill.keyword || bill.debitKeyword).split('|');
    for (const kw of keywords) {
      const kwTrim = kw.trim();
      if (!kwTrim) continue;
      if (merchant.includes(kwTrim)) {
        // For Affirm — match any AFFIRM* prefix
        if (kwTrim === 'AFFIRM' && !merchant.startsWith('AFFIRM')) continue;
        return { status: "matched", bill: bill.id, label: bill.name };
      }
    }
  }

  // 4. Capital One — multiple bills share the merchant name, disambiguate by amount
  if (merchant.includes("CAPITAL ONE")) {
    const capOneBills = userBills.filter(b => b.keyword && b.keyword.includes("CAPITAL ONE"));
    if (capOneBills.length) {
      const sorted = capOneBills
        .map(b => ({ ...b, diff: Math.abs(amt - b.amt) }))
        .sort((a, b) => a.diff - b.diff);
      if (sorted[0].diff <= 10) {
        return { status: "matched", bill: sorted[0].id, label: sorted[0].name };
      }
    }
    return { status: "pending" };
  }

  // 5. Affirm prefix match (suffix changes each payment)
  if (merchant.startsWith("AFFIRM")) {
    // Find closest Affirm bill by amount
    const affirmBills = userBills.filter(b => b.id.startsWith('affirm'));
    if (affirmBills.length) {
      const sorted = affirmBills
        .map(b => ({ ...b, diff: Math.abs(amt - b.amt) }))
        .sort((a, b) => a.diff - b.diff);
      if (sorted[0].diff <= 2) {
        return { status: "matched", bill: sorted[0].id, label: sorted[0].name };
      }
    }
    return { status: "matched", bill: "affirm", label: "Affirm (unmatched plan)" };
  }

  // 6. No match
  return { status: "pending" };
}

// ── Convert USAA date "05/05/26" → "5/5/2026" ──
function formatUsaaDate(usaaDate) {
  const parts = usaaDate.split("/");
  if (parts.length !== 3) return usaaDate;
  return `${parseInt(parts[0])}/${parseInt(parts[1])}/${2000 + parseInt(parts[2])}`;
}

// ── Helpers ──
function sendEmail(subject, body) {
  GmailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function firebasePut(url, value) {
  const res = UrlFetchApp.fetch(url, {
    method: "PUT",
    contentType: "application/json",
    payload: JSON.stringify(value),
    muteHttpExceptions: true,
  });
  return res.getResponseCode();
}

function firebaseGet(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
  return null;
}