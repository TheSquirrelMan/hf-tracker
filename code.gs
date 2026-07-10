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
  const yesterday = new Date(today.getTime() - 86400000);
  const dateStr = Utilities.formatDate(yesterday, "America/New_York", "yyyy/MM/dd");
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
       const balMatch = body.match(/Available balance:\s*\n?\s*(-?\$[0-9,]+\.\d{2})/);
       if (!balMatch) { Logger.log("Could not parse balance."); continue; }
       const balance = parseFloat(balMatch[1].replace(/[$,]/g, ""));
      Logger.log(`Balance parsed: $${balance} for account ${acctNum}`);

      // Write to the correct Firebase key based on account number
      const fbKey = acctNum === '4496' ? 'bal4496' : acctNum === '0725' ? 'bal0725' : acctNum === '6764' ? 'bal6764' : null;
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
  const yesterday = new Date(today.getTime() - 86400000);
  const dateStr = Utilities.formatDate(yesterday, "America/New_York", "yyyy/MM/dd");
  const query = `from:${USAA_SENDER} subject:"Deposit to Your Bank Account" after:${dateStr}`;
  const threads = GmailApp.search(query, 0, 10);
  if (!threads.length) return;

  let label = GmailApp.getUserLabelByName(KAREN_PAY_LABEL);
  if (!label) label = GmailApp.createLabel(KAREN_PAY_LABEL);
  const labelId = getLabelId(KAREN_PAY_LABEL);

  const state = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  const processedIds = state.processedKarenPayIds || [];

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
      firebasePut(`${FIREBASE_BASE}/processedKarenPayIds.json`, processedIds.slice(-200));
      labelMessage(msgId, labelId);
      Logger.log(`✓ karenLastPay updated: $${amount}, karenAvgPay: $${newKarenAvg}`);
      const currentBal = firebaseGet(`${FIREBASE_BASE}/bal4496.json`) || 0;
      sendSnowballReminder(currentBal, `Karen's pay of $${amount.toFixed(2)} just landed`);
    }
  }
}

// ── 3. Jon paycheck sync (runs daily) ──
function syncJonPay() {
  initFirebasePath();
  const today = new Date();

  // [JOBSYNC] Search 4 days back so deposits are caught even if a trigger was missed
  const since = new Date(today.getTime() - 4 * 86400000);
  const dateStr = Utilities.formatDate(since, "America/New_York", "yyyy/MM/dd");
  Logger.log(`[JOBSYNC] searching deposits after ${dateStr}`);
  const query = `from:${USAA_SENDER} subject:"Deposit to Your Bank Account" after:${dateStr}`;
  const threads = GmailApp.search(query, 0, 10);
  if (!threads.length) {
    Logger.log("[JOBSYNC] no deposit threads found");
    return;
  }
  Logger.log(`[JOBSYNC] deposit threads found: ${threads.length}`);

  let label = GmailApp.getUserLabelByName(JON_PAY_LABEL);
  if (!label) label = GmailApp.createLabel(JON_PAY_LABEL);
  const labelId = getLabelId(JON_PAY_LABEL);

  const state = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  const processedIds = state.processedJonPayIds || [];

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (processedIds.includes(msgId)) {
        Logger.log(`[JOBSYNC] skipping msgId ${msgId} — already in processedJonPayIds`);
        continue;
      }
      const existingLabels = getMessageLabelIds(msgId);
      if (existingLabels.includes(labelId)) {
        Logger.log(`[JOBSYNC] skipping msgId ${msgId} — already labeled usaa-jon-pay-synced`);
        continue;
      }

      const body = msg.getPlainBody();
      if (!body.toUpperCase().includes("APPLIED BEHAVIOR")) {
        Logger.log(`[JOBSYNC] SKIP msgId ${msgId} — body missing 'APPLIED BEHAVIOR'. body: ${body.substring(0, 200).replace(/\n/g, '↵')}`);
        continue;
      }

      const match = body.match(/Amount:[\s\S]*?\$([0-9,]+\.\d{2})/);
      if (!match) {
        Logger.log(`[JOBSYNC] SKIP msgId ${msgId} — failed to parse amount. body: ${body.substring(0, 200).replace(/\n/g, '↵')}`);
        continue;
      }
      const amount = parseFloat(match[1].replace(/,/g, ""));

      firebasePut(`${FIREBASE_BASE}/jonLastPay.json`, amount);
      firebasePut(`${FIREBASE_BASE}/jonLastPayDate.json`, Utilities.formatDate(today, "America/New_York", "yyyy-MM-dd"));
      const prevAvg = state.jonAvgPay || amount;
      const newAvg = Math.round((prevAvg * 0.7) + (amount * 0.3));
      firebasePut(`${FIREBASE_BASE}/jonAvgPay.json`, newAvg);
      processedIds.push(msgId);
      firebasePut(`${FIREBASE_BASE}/processedJonPayIds.json`, processedIds.slice(-200));
      labelMessage(msgId, labelId);
      Logger.log(`[JOBSYNC] SYNCED msgId ${msgId} — jonLastPay: $${amount}, jonAvgPay: $${newAvg}`);
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

  // Don't notify about paid-off cards until expense phases are complete
  const phases     = state.phases     || [];
  const phaseDone  = state.phaseDone  || {};
  const allPhasesDone = phases.length > 0 && phases.every(p => phaseDone[p.id]);

  if (!allPhasesDone) {
    Logger.log("checkMilestones: expense phases not complete, skipping paid-off notifications");
    return;
  }

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
  const today = Utilities.formatDate(new Date(), "America/New_York", "yyyy-MM-dd");
  const lastSent = firebaseGet(`${FIREBASE_BASE}/lastSnowballReminderDate.json`);
  if (lastSent === today) { Logger.log("Snowball reminder already sent today, skipping."); return; }

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

  const allPhasesDone = phasesWithCosts.length > 0 && phasesWithCosts.every(p => phaseDone[p.id]);

  if (!allPhasesDone) {
    const nextPhase = phasesWithCosts.find(p => !phaseDone[p.id]);
    if (nextPhase) {
      sendEmail(
        '💰 HF Tracker — Paycheck Landed',
        `${context}\n\nCurrent #4496 balance: $${currentBal.toFixed(2)}\n\n` +
        `You are saving for: ${nextPhase.label} ($${nextPhase.cost.toLocaleString()})\n\nDo nothing — leave the money in #4496.`
      );
      firebasePut(`${FIREBASE_BASE}/lastSnowballReminderDate.json`, today);
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
  firebasePut(`${FIREBASE_BASE}/lastSnowballReminderDate.json`, today);
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
  let   debitLog   = (state.debitLog    || []).filter(d => d != null);
  const userBills  = state.userBills   || [];
  let   cardBals   = state.cardBals    || {};
  const cardStartBals = state.cardStartBals || {};
  let   changed    = false;
  let   newPending = 0;

  const nowDate = new Date();
  const curMKey = `${nowDate.getFullYear()}-${nowDate.getMonth()}`;
  const stateMKey = state.mKey || '';
  if (stateMKey !== curMKey) {
    // Month rollover — archive old discLog, reset monthly counters
    if (state.discLog && state.discLog.length > 0 && stateMKey) {
      firebasePut(`${FIREBASE_BASE}/discLogArchive/${stateMKey}.json`, state.discLog);
    }
    firebasePut(`${FIREBASE_BASE}/mKey.json`, curMKey);
    firebasePut(`${FIREBASE_BASE}/discSpent.json`, 0);
    firebasePut(`${FIREBASE_BASE}/discLog.json`, []);
    Logger.log(`Month rollover: ${stateMKey} → ${curMKey}`);
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
      // Compute day-of-week explicitly in America/New_York, not the script's project
      // timezone, so a debit near midnight ET isn't attributed to the wrong day
      const DOW_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const txDow = DOW_NAMES.indexOf(Utilities.formatDate(msg.getDate(), "America/New_York", "EEEE"));

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

      const result = matchDebit(merchant, amt, userBills, txDow);
      Logger.log(`Match: ${result.status}${result.bill ? " → " + result.bill : ""}`);

      const entry = { merchant, amt, date: txDate, ts: new Date().getTime(), status: result.status };
      if (result.bill)  entry.bill  = result.bill;
      if (result.label) entry.label = result.label;
      debitLog.unshift(entry);

      if (result.freshMarket) {
        // discLog overage handled by syncFreshMarket (email parsing) — just record the debit
        Logger.log(`Fresh Market PayPal $${amt} matched bill_fresh_market — discLog via syncFreshMarket`);
      }

      // Auto-update card balance when a payment is matched to a credit card
      if (result.status === 'matched' && result.bill) {
        const bill = userBills.find(b => b.id === result.bill);
        if (bill && bill.cardId) {
          const start = cardStartBals[bill.cardId] || 0;
          const prev = cardBals[bill.cardId] !== undefined ? cardBals[bill.cardId] : start;
          const next = Math.max(0, prev - amt);
          cardBals[bill.cardId] = next;
          Logger.log(`cardBals[${bill.cardId}]: $${prev} → $${next}`);
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
    firebasePut(`${FIREBASE_BASE}/cardBals.json`,        cardBals);
    firebasePut(`${FIREBASE_BASE}/processedMsgIds.json`, processedIds.slice(-500));
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
function matchDebit(merchant, amt, userBills, txDow) {

  // 1. PayPal Fresh Market: within 50% of bill amount, arrived Sun/Mon/Tue
  if (merchant.includes("PAYPAL")) {
    const fmBill = userBills.find(b => b.id === 'bill_fresh_market');
    if (fmBill) {
      const fmAmt = fmBill.amt || 200;
      if (amt >= fmAmt * 0.5 && amt <= fmAmt * 1.5 && txDow >= 0 && txDow <= 2) {
        return { status: "matched", bill: "bill_fresh_market", label: "Fresh Market", cat: "groceries", freshMarket: true, budgetAmt: fmAmt };
      }
    }
  }

  // 2. Match against userBills keywords from Firebase
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

  // 3. Capital One — multiple bills share the merchant name, disambiguate by amount
  if (merchant.includes("CAPITAL ONE")) {
    const capOneBills = userBills.filter(b => (b.keyword || b.debitKeyword || "").includes("CAPITAL ONE"));
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

  // 4. Affirm prefix match (suffix changes each payment)
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
    return { status: "pending" };
  }

  // 5. No match — falls to the Debit Inbox for manual categorization
  return { status: "pending" };
}

// ── Convert USAA date "05/05/26" → "5/5/2026" ──
function formatUsaaDate(usaaDate) {
  const parts = usaaDate.split("/");
  if (parts.length !== 3) return usaaDate;
  return `${parseInt(parts[0])}/${parseInt(parts[1])}/${2000 + parseInt(parts[2])}`;
}

// ── Sync Fresh Market receipt emails → log overage above bill budget to discLog ──
function syncFreshMarket() {
  initFirebasePath();
  const state      = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  const userBills  = state.userBills  || [];
  let   discLog    = state.discLog    || [];
  let   discSpent  = state.discSpent  || 0;
  const processedIds = state.processedFreshMarketIds || [];

  const nowDate = new Date();
  const curMKey = `${nowDate.getFullYear()}-${nowDate.getMonth()}`;
  const stateMKey = state.mKey || '';
  if (stateMKey !== curMKey) {
    if (state.discLog && state.discLog.length > 0 && stateMKey) {
      firebasePut(`${FIREBASE_BASE}/discLogArchive/${stateMKey}.json`, state.discLog);
    }
    firebasePut(`${FIREBASE_BASE}/mKey.json`, curMKey);
    firebasePut(`${FIREBASE_BASE}/discSpent.json`, 0);
    firebasePut(`${FIREBASE_BASE}/discLog.json`, []);
    discLog = [];
    discSpent = 0;
    Logger.log(`syncFreshMarket month rollover: ${stateMKey} → ${curMKey}`);
  }

  const fmBill    = userBills.find(b => b.id === 'bill_fresh_market');
  const budgetAmt = fmBill ? (fmBill.amt || 0) : 0;

  const since   = new Date(new Date().getTime() - 14 * 24 * 60 * 60 * 1000);
  const dateStr = Utilities.formatDate(since, "America/New_York", "yyyy/MM/dd");
  const threads = GmailApp.search(
    `from:orders@thefreshmarket.com subject:"The Fresh Market order receipt" after:${dateStr}`,
    0, 10
  );

  let changed = false;

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (processedIds.includes(msgId)) continue;

      const body = msg.getPlainBody() || msg.getBody().replace(/<[^>]+>/g, ' ');

      const totalMatch = body.match(/\bTotal:\s*\$(\d+\.\d{2})/);
      if (!totalMatch) {
        Logger.log(`Fresh Market: could not parse total from msg ${msgId}`);
        processedIds.push(msgId);
        continue;
      }

      const total   = parseFloat(totalMatch[1]);
      const overage = Math.max(0, Math.round((total - budgetAmt) * 100) / 100);
      const txDate  = Utilities.formatDate(msg.getDate(), "America/New_York", "M/d/yyyy");

      Logger.log(`Fresh Market receipt: total=$${total} budget=$${budgetAmt} overage=$${overage} date=${txDate}`);

      if (overage > 0) {
        const txParts  = txDate.split('/');
        const txMillis = new Date(parseInt(txParts[2]), parseInt(txParts[0])-1, parseInt(txParts[1])).getTime();
        const matchIdx = discLog.findIndex(e => {
          const ep = (e.date||'').split('/');
          if (ep.length < 3) return false;
          const eMillis = new Date(parseInt(ep[2]), parseInt(ep[0])-1, parseInt(ep[1])).getTime();
          if (Math.abs(txMillis - eMillis) / 86400000 > 2) return false;
          return (e.label||'').includes('Fresh Market');
        });
        if (matchIdx >= 0) {
          const old = discLog[matchIdx];
          discSpent = Math.max(0, discSpent - (old.amt||0));
          discLog[matchIdx] = {...old, amt: overage, date: txDate, cat: 'discretionary', auto: true, confirmed: true};
          discSpent += overage;
        } else {
          discLog.unshift({ amt: overage, date: txDate, label: 'Fresh Market (extra)', cat: 'discretionary', auto: true });
          discSpent += overage;
        }
        changed = true;
      }

      processedIds.push(msgId);
    }
  }

  if (changed) {
    firebasePut(`${FIREBASE_BASE}/discLog.json`,  discLog);
    firebasePut(`${FIREBASE_BASE}/discSpent.json`, discSpent);
  }
  firebasePut(`${FIREBASE_BASE}/processedFreshMarketIds.json`, processedIds.slice(-100));
  Logger.log(`syncFreshMarket done. changed=${changed}`);
}

// ── One-shot: patch jonLastPayDate after manual sync run ──
function patchJonPayDate() {
  initFirebasePath();
  const today = Utilities.formatDate(new Date(), "America/New_York", "yyyy-MM-dd");
  firebasePut(`${FIREBASE_BASE}/jonLastPayDate.json`, today);
  Logger.log(`✓ jonLastPayDate set to ${today}`);
}

// ── One-shot: tighten Mazda keyword + purge phantom debit matches + restore cardBals ──
function cleanMazdaPhantoms() {
  initFirebasePath();

  // 1. Tighten the keyword on the live bill
  const bills = firebaseGet(`${FIREBASE_BASE}/userBills.json`) || [];
  const bIdx = bills.findIndex(b => b.id === 'bill_mazda');
  if (bIdx >= 0) {
    bills[bIdx].keyword = 'MAZDA FINANCIAL WEB';
    firebasePut(`${FIREBASE_BASE}/userBills.json`, bills);
    Logger.log('✓ Mazda keyword updated to MAZDA FINANCIAL WEB');
  }

  // 2. Purge phantom debitLog entries (any mazda match whose amount isn't $638)
  const state = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  let debitLog = (state.debitLog || []).filter(d => d != null);
  let cardBals = state.cardBals || {};
  const startBals = state.cardStartBals || {};
  let phantomTotal = 0;
  debitLog = debitLog.filter(d => {
    if (d.bill === 'bill_mazda' && d.amt !== 638) {
      phantomTotal += d.amt;
      Logger.log(`Removing phantom: $${d.amt} on ${d.date}`);
      return false;
    }
    return true;
  });
  firebasePut(`${FIREBASE_BASE}/debitLog.json`, debitLog);

  // 3. Restore phantom amounts to cardBals['mazda']
  if (phantomTotal > 0) {
    const start = startBals.mazda || 0;
    const prev = cardBals.mazda !== undefined ? cardBals.mazda : start;
    cardBals.mazda = prev + phantomTotal;
    firebasePut(`${FIREBASE_BASE}/cardBals.json`, cardBals);
    Logger.log(`✓ cardBals[mazda] restored: $${prev} → $${cardBals.mazda} (+$${phantomTotal})`);
  }
  Logger.log('✓ cleanMazdaPhantoms complete');
}

// ── One-shot: fix Amazon card keyword + restore balance ──
function fixAmazonData() {
  initFirebasePath();
  const state = firebaseGet(`${FIREBASE_BASE}.json`) || {};

  // 1. Update the bill keyword from 'AMAZON' → 'AMZ_STORECRD'
  const bills = state.userBills || [];
  const bIdx = bills.findIndex(b => b.id === 'bill_amazon_store');
  if (bIdx >= 0) {
    bills[bIdx].keyword = 'AMZ_STORECRD';
    firebasePut(`${FIREBASE_BASE}/userBills.json`, bills);
    Logger.log('✓ Amazon Store Card keyword updated to AMZ_STORECRD');
  }

  // 2. Restore card balance to starting balance ($235)
  let cardBals = state.cardBals || {};
  cardBals.amazon = 235;
  firebasePut(`${FIREBASE_BASE}/cardBals.json`, cardBals);
  Logger.log('✓ cardBals[amazon] restored to $235');

  Logger.log('✓ fixAmazonData complete — run once');
}

// ── Seed / restore baseline data to Firebase ──
// Run this once from the Apps Script editor if Firebase is ever wiped.
// Does NOT overwrite live balances (bal4496/cardBals), spend logs, or processed IDs.
function seedDefaultBills() {
  initFirebasePath();

  const userBills = [
    // ── Fixed-term debts (cardId = snowball target) ──
    { id:'bill_amazon_store',   name:'Amazon Store Card',       amt:29,  day:1,  cardId:'amazon',   endDate:'2026-08', keyword:'AMZ_STORECRD' },
    { id:'bill_cap3186',        name:'Cap One #3186 (Karen)',    amt:25,  day:11, cardId:'cap3186',  endDate:'2026-10', keyword:'CAPITAL ONE' },
    { id:'bill_cap4565',        name:'Cap One #4565 (Jon)',      amt:25,  day:21, cardId:'cap4565',  endDate:'2026-12', keyword:'CAPITAL ONE' },
    { id:'bill_cap5592',        name:'Cap One #5592 (Karen)',    amt:25,  day:21, cardId:'cap5592',  endDate:'2026-12', keyword:'CAPITAL ONE' },
    { id:'bill_cap7988',        name:'Cap One #7988 (Jon)',      amt:30,  day:21, cardId:'cap7988',  endDate:'2027-01', keyword:'CAPITAL ONE' },
    { id:'bill_merrick',        name:'Merrick Bank',             amt:35,  day:11, cardId:'merrick',  endDate:'2026-11', keyword:'MERRICK' },
    { id:'bill_chase',          name:'Chase/Amazon Prime',       amt:26,  day:26, cardId:'chase',    endDate:'2027-04', keyword:'CHASE' },
    { id:'bill_usaa_amex',      name:'USAA Amex (Karen)',        amt:63,  day:15, cardId:'usaaAmex', endDate:'2027-02', keyword:'USAA' },
    { id:'bill_kpaypal',        name:"Karen's PayPal Credit",    amt:100, day:13, cardId:'kpaypal',  endDate:'2027-05', keyword:'PAYPAL' },
    { id:'bill_tn',             name:'TN Unemployment',          amt:153, day:22, cardId:'tn',       endDate:'2027-12', keyword:'TN' },
    { id:'bill_irs2',           name:'IRS payment #2',           amt:35,  day:16, cardId:'irs2',      endDate:'2028-06', keyword:'IRS' },
    { id:'bill_irs1',           name:'IRS payment #1',           amt:68,  day:15, cardId:'irs1',      endDate:'2028-06', keyword:'IRS' },
    { id:'bill_mazda',          name:'Mazda CX-5',               amt:638, day:9,  cardId:'mazda',    endDate:'2027-04', keyword:'MAZDA FINANCIAL WEB' },
    // ── Fixed-term (no cardId — expire by date) ──
    { id:'bill_paypal_newegg',  name:'PayPal Newegg',            amt:61,  day:13, endDate:'2027-01', conditionEnd:'2027-01' },
    { id:'bill_jon_paypal',     name:'Jon PayPal Credit',        amt:22,  day:22, endDate:'2029-10', conditionEnd:'2029-10' },
    { id:'bill_paypal_chinese', name:'PayPal Chinese vendor',    amt:95,  day:30, endDate:'2027-03', conditionEnd:'2027-03' },
    { id:'bill_paypal_ebay',    name:'PayPal eBay',              amt:43,  day:4,  endDate:'2027-08', conditionEnd:'2027-08' },
    // ── Affirm plans (self-liquidating) ──
    { id:'affirm_01',           name:'Affirm #1',                amt:9.04,  day:13, endDate:'2026-07-12' },
    { id:'affirm_02',           name:'Affirm #2',                amt:12.80, day:13, endDate:'2026-08-19' },
    { id:'affirm_03',           name:'Affirm #3',                amt:11.47, day:13, endDate:'2026-09-02' },
    { id:'affirm_04',           name:'Affirm #4',                amt:32.88, day:13, endDate:'2026-09-10' },
    { id:'affirm_05',           name:'Affirm #5',                amt:13.38, day:13, endDate:'2026-10-10' },
    { id:'affirm_06',           name:'Affirm #6',                amt:23.24, day:13, endDate:'2027-02-13' },
    { id:'affirm_07',           name:'Affirm #7',                amt:27.45, day:13, endDate:'2027-10-03' },
    { id:'affirm_08',           name:'Affirm #8',                amt:29.91, day:13, endDate:'2027-10-14' },
    { id:'affirm_09',           name:'Affirm #9',                amt:29.00, day:13, endDate:'2028-03-02' },
    // ── Recurring ──
    { id:'bill_amazon_prime',   name:'Amazon Prime',             amt:15,  day:2  },
    { id:'bill_real_debrid',    name:'Real-Debrid',              amt:11,  day:2  },
    { id:'bill_chatgpt',        name:'ChatGPT',                  amt:22,  day:4  },
    { id:'bill_claude',         name:'Claude.ai',                amt:20,  day:13 },
    { id:'bill_tmobile',        name:'T-Mobile',                 amt:152, day:15, keyword:'TMOBILE AU' },
    { id:'bill_att',            name:'AT&T fiber',               amt:166, day:16, keyword:'ATT*BILL PAYMENT' },
    { id:'bill_spotify',        name:'Spotify',                  amt:22,  day:22 },
    { id:'bill_state_farm',     name:'State Farm',               amt:190, day:23 },
    { id:'bill_fresh_market',   name:'Fresh Market',             amt:200, day:0  },
    { id:'bill_gas',            name:'Gas (monthly est.)',        amt:120, day:1  },
  ];

  const phases = [
    { id:'repair-buf',  label:'Repair buffer (savings)', cost:1000, isSavings:true },
    { id:'jon-tires',   label:"Jon's tires + oil",       cost:1500 },
    { id:'karen-tires', label:"Karen's tires",           cost:1000 },
    { id:'dental',      label:'Dental — Jon + Karen',    cost:600  },
    { id:'glasses',     label:'Glasses — Jon + Karen',   cost:1000 },
  ];

  // Starting balances as of 2026-05-21 — update cardBals manually after any snowball payments
  const cardStartBals = {
    amazon:   235,
    cap3186:  491,
    cap4565:  726,
    cap5592:  731,
    cap7988:  843,
    merrick:  926,
    chase:    951,
    usaaAmex: 1847,
    kpaypal:  1958,
    tn:       3653,
    irs1:     3147,
    irs2:     1620,
    mazda:    20693,
  };

  firebasePut(`${FIREBASE_BASE}/cardStartBals.json`,  cardStartBals);
  firebasePut(`${FIREBASE_BASE}/discMonthlyCap.json`, 200);
  firebasePut(`${FIREBASE_BASE}/discWeekly.json`,     50);
  firebasePut(`${FIREBASE_BASE}/karenAvgPay.json`,    787);
  firebasePut(`${FIREBASE_BASE}/jonAvgPay.json`,      1641);

  Logger.log('✓ seedDefaultBills complete — live balances and logs untouched');
}

// ── One-shot: upsert affirm bills into existing userBills without touching anything else ──
function seedAffirmBills() {
  initFirebasePath();
  const state = firebaseGet(`${FIREBASE_BASE}.json`) || {};
  const bills = state.userBills || [];

  const affirmBills = [
    { id:'affirm_01', name:'Affirm #1', amt:9.04,  day:13, endDate:'2026-07-12' },
    { id:'affirm_02', name:'Affirm #2', amt:12.80, day:13, endDate:'2026-08-19' },
    { id:'affirm_03', name:'Affirm #3', amt:11.47, day:13, endDate:'2026-09-02' },
    { id:'affirm_04', name:'Affirm #4', amt:32.88, day:13, endDate:'2026-09-10' },
    { id:'affirm_05', name:'Affirm #5', amt:13.38, day:13, endDate:'2026-10-10' },
    { id:'affirm_06', name:'Affirm #6', amt:23.24, day:13, endDate:'2027-02-13' },
    { id:'affirm_07', name:'Affirm #7', amt:27.45, day:13, endDate:'2027-10-03' },
    { id:'affirm_08', name:'Affirm #8', amt:29.91, day:13, endDate:'2027-10-14' },
    { id:'affirm_09', name:'Affirm #9', amt:29.00, day:13, endDate:'2028-03-02' },
  ];

  for (const ab of affirmBills) {
    const idx = bills.findIndex(b => b.id === ab.id);
    if (idx >= 0) {
      bills[idx] = { ...bills[idx], ...ab };
      Logger.log(`Updated ${ab.id}`);
    } else {
      bills.push(ab);
      Logger.log(`Added ${ab.id}`);
    }
  }

  firebasePut(`${FIREBASE_BASE}/userBills.json`, bills);
  Logger.log('✓ seedAffirmBills complete — ' + affirmBills.length + ' bills upserted');
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