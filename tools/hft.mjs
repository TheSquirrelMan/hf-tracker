#!/usr/bin/env node
// hft — query and plan against the HF Tracker finance model from outside the browser.
// Designed to be readable by a person OR piped to an LLM: every command can emit JSON.
//
//   node tools/hft.mjs plan   --live
//   node tools/hft.mjs whatif --live --set '{"userBills":[{"id":"mazda","amt":900}]}'
//   node tools/hft.mjs debts  --live --json        # machine-readable, for an LLM
//   node tools/hft.mjs plan   --state s.json       # or from a saved snapshot
//
// --set takes a partial state. Objects deep-merge; userBills/phases merge BY id, so you
// can nudge one bill's amount without restating the array.
import { readFileSync } from 'fs';
import { createEngine } from '../engine.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = n => argv.includes('--' + n);
const asJson = has('json');

if (!cmd || has('help')) {
  console.log('commands: plan | debts | bills | whatif   flags: --live | --state <f>   --now <YYYY-MM-DD>   --set <json>   --json');
  process.exit(0);
}
const DB = 'https://hf-tracker-81e76-default-rtdb.firebaseio.com';
let _secret = null;
async function secret() {
  if (_secret) return _secret;
  const cfg = await (await fetch(`${DB}/app_config.json`)).json();
  if (!cfg || !cfg.dataSecret) throw new Error('could not read app_config');
  return (_secret = cfg.dataSecret);   // never printed or written to disk
}
async function loadLive() {
  const st = await (await fetch(`${DB}/hft/${await secret()}/state.json`)).json();
  if (!st) throw new Error('could not read state');
  return st;
}
// Surgical single-field write. Deliberately NOT a whole-state PUT: the web app's
// pending-save merge list omits userBills/phases/cardBals, so a broad write races
// with anything he is editing in the PWA.
async function putField(path, value) {
  const r = await fetch(`${DB}/hft/${await secret()}/state/${path}.json`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.status;
}

const statePath = flag('state');
let base;
if (has('live')) base = await loadLive();
else if (statePath) base = JSON.parse(readFileSync(statePath, 'utf8'));
else { console.error('need --live, or --state <file.json>'); process.exit(2); }
const now = flag('now');

const byId = (arr, patch) => {
  const out = (arr || []).map(x => ({ ...x }));
  for (const p of patch) {
    const i = out.findIndex(x => x.id === p.id);
    if (i >= 0) Object.assign(out[i], p); else out.push(p);
  }
  return out;
};
function applySet(state, set) {
  const s = JSON.parse(JSON.stringify(state));
  for (const [k, v] of Object.entries(set)) {
    if ((k === 'userBills' || k === 'phases') && Array.isArray(v)) s[k] = byId(s[k], v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) s[k] = { ...(s[k] || {}), ...v };
    else s[k] = v;
  }
  return s;
}

function model(state) {
  const e = createEngine({ state, now });
  const r = e.calcRoadmap();
  const targets = e.getSnowballTargets();
  const debts = targets.map(t => ({
    id: t.id,
    name: t.label,
    balance: Math.round(e.bal(state.cardBals || {}, t.id) * 100) / 100,
    payoff: (r.milestones[t.id + '-done'] || {}).date || null,
  }));
  const phases = e.getPhases().map(p => ({
    id: p.id, label: p.label,
    cost: e.phaseAmt(p.id, p.cost),
    done: !!(state.phaseDone || {})[p.id],
    date: (r.milestones[p.id] || {}).date || null,
  }));
  const jon = state.jonAvgPay || 0, karen = state.karenAvgPay || 0;
  const monthlyIncome = Math.round(jon * 2 + karen * 4.33);
  const billsMonthly = Math.round((state.userBills || []).reduce((a, b) => a + e.toMonthlyAmt(b), 0));
  const payoffDates = debts.map(d => d.payoff).filter(Boolean).sort();
  return {
    // local components, never toISOString — that reports tomorrow after ~20:00 ET
    asOf: now || (d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)(new Date()),
    checking: state.bal4496, savings: state.bal0725,
    monthlyIncome, billsMonthly,
    surplus: monthlyIncome - billsMonthly - (state.discMonthlyCap || 0),
    debtTotal: Math.round(debts.reduce((a, d) => a + Math.max(0, d.balance), 0) * 100) / 100,
    debtFreeDate: payoffDates.length ? payoffDates[payoffDates.length - 1] : null,
    debts, phases,
  };
}

const m = model(base);

if (cmd === 'plan' || cmd === 'debts' || cmd === 'bills') {
  if (asJson) { console.log(JSON.stringify(cmd === 'plan' ? m : cmd === 'debts' ? m.debts : base.userBills, null, 2)); process.exit(0); }
  if (cmd === 'bills') {
    const e = createEngine({ state: base, now });
    console.log('BILLS'.padEnd(34) + 'amt'.padStart(9) + '/mo'.padStart(10) + '   due');
    for (const b of base.userBills || [])
      console.log(`${(b.name || b.id).slice(0, 32).padEnd(34)}${('$' + b.amt).padStart(9)}${('$' + Math.round(e.toMonthlyAmt(b))).padStart(10)}   ${JSON.stringify(b.day)}`);
    process.exit(0);
  }
  console.log(`as of ${m.asOf}`);
  console.log(`  checking $${m.checking}   savings $${m.savings}`);
  console.log(`  income  $${m.monthlyIncome}/mo    bills $${m.billsMonthly}/mo    surplus $${m.surplus}/mo`);
  console.log(`  debt    $${m.debtTotal}  ->  debt-free ${m.debtFreeDate || 'n/a'}`);
  if (cmd === 'plan') {
    console.log('\nDEBTS' + ' '.repeat(26) + 'balance'.padStart(11) + '   payoff');
    for (const d of m.debts)
      console.log(`  ${(d.name || d.id).slice(0, 28).padEnd(29)}${('$' + d.balance).padStart(11)}   ${d.payoff || '-'}`);
    console.log('\nPHASES' + ' '.repeat(28) + 'cost'.padStart(8) + '   when');
    for (const p of m.phases)
      console.log(`  ${p.label.slice(0, 28).padEnd(29)}${('$' + p.cost).padStart(8)}   ${p.done ? 'done' : (p.date || '-')}`);
  }
  process.exit(0);
}

if (cmd === 'whatif') {
  const set = JSON.parse(flag('set') || '{}');
  const alt = model(applySet(base, set));
  if (asJson) { console.log(JSON.stringify({ baseline: m, scenario: alt, set }, null, 2)); process.exit(0); }
  const d = (a, b, unit = '$') => a === b ? '' : `   (${unit}${a} -> ${unit}${b})`;
  console.log(`SCENARIO ${JSON.stringify(set)}\n`);
  console.log(`  surplus/mo   $${m.surplus}${d(m.surplus, alt.surplus)}`);
  console.log(`  debt total   $${m.debtTotal}${d(m.debtTotal, alt.debtTotal)}`);
  console.log(`  debt-free    ${m.debtFreeDate || 'n/a'}${m.debtFreeDate !== alt.debtFreeDate ? `   (-> ${alt.debtFreeDate || 'n/a'})` : ''}`);
  const rows = m.debts.map((x, i) => [x, alt.debts[i]]).filter(([a, b]) => b && a.payoff !== b.payoff);
  if (rows.length) {
    console.log('\n  payoff dates that move:');
    for (const [a, b] of rows) console.log(`    ${(a.name || a.id).slice(0, 26).padEnd(28)} ${a.payoff || '-'}  ->  ${b.payoff || '-'}`);
  } else console.log('\n  no payoff dates move');
  const ph = m.phases.map((x, i) => [x, alt.phases[i]]).filter(([a, b]) => b && a.date !== b.date);
  if (ph.length) {
    console.log('\n  milestones that move:');
    for (const [a, b] of ph) console.log(`    ${a.label.slice(0, 26).padEnd(28)} ${a.date || '-'}  ->  ${b.date || '-'}`);
  }
  process.exit(0);
}
// ── set: change the live model. DRY RUN unless --apply. ──────────────────────────
if (cmd === 'set') {
  if (!has('live')) { console.error('set requires --live'); process.exit(2); }
  const set = JSON.parse(flag('set') || '{}');
  if (!Object.keys(set).length) { console.error('nothing to set'); process.exit(2); }

  // resolve every change to an exact Firebase path + before/after value
  const writes = [];
  for (const [k, v] of Object.entries(set)) {
    if ((k === 'userBills' || k === 'phases') && Array.isArray(v)) {
      for (const patch of v) {
        const i = (base[k] || []).findIndex(x => x && x.id === patch.id);
        if (i < 0) { console.error(`${k}: no entry with id "${patch.id}" — refusing to create one`); process.exit(2); }
        for (const [f, val] of Object.entries(patch)) {
          if (f === 'id') continue;
          writes.push({ path: `${k}/${i}/${f}`, label: `${k}[${patch.id}].${f}`, from: base[k][i][f], to: val });
        }
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [f, val] of Object.entries(v))
        writes.push({ path: `${k}/${f}`, label: `${k}.${f}`, from: (base[k] || {})[f], to: val });
    } else {
      writes.push({ path: k, label: k, from: base[k], to: v });
    }
  }

  const alt = model(applySet(base, set));
  console.log(has('apply') ? 'APPLYING\n' : 'DRY RUN — nothing written. Re-run with --apply.\n');
  console.log('  changes:');
  for (const w of writes) console.log(`    ${w.label.padEnd(30)} ${JSON.stringify(w.from)}  ->  ${JSON.stringify(w.to)}`);
  console.log('\n  projection impact:');
  console.log(`    surplus/mo   $${m.surplus}${m.surplus !== alt.surplus ? `  ->  $${alt.surplus}` : '  (unchanged)'}`);
  console.log(`    debt total   $${m.debtTotal}${m.debtTotal !== alt.debtTotal ? `  ->  $${alt.debtTotal}` : '  (unchanged)'}`);
  console.log(`    debt-free    ${m.debtFreeDate}${m.debtFreeDate !== alt.debtFreeDate ? `  ->  ${alt.debtFreeDate}` : '  (unchanged)'}`);
  const moved = m.debts.map((x, i) => [x, alt.debts[i]]).filter(([a, b]) => b && a.payoff !== b.payoff);
  for (const [a, b] of moved) console.log(`    ${(a.name || a.id).slice(0, 26).padEnd(28)} ${a.payoff} -> ${b.payoff}`);

  if (!has('apply')) process.exit(0);

  console.log('');
  let bad = 0;
  for (const w of writes) {
    const code = await putField(w.path, w.to);
    console.log(`    PUT ${w.label.padEnd(30)} HTTP ${code}`);
    if (code !== 200) bad++;
  }
  const after = await loadLive();          // read back, never trust the status alone
  const check = writes.map(w => {
    const got = w.path.split('/').reduce((o, k) => (o == null ? o : o[k]), after);
    return { label: w.label, want: w.to, got, ok: JSON.stringify(got) === JSON.stringify(w.to) };
  });
  console.log('\n  read-back:');
  for (const c of check) console.log(`    ${c.label.padEnd(30)} ${c.ok ? 'ok' : `MISMATCH want ${JSON.stringify(c.want)} got ${JSON.stringify(c.got)}`}`);
  const failed = bad || check.some(c => !c.ok);
  console.log(failed ? '\n  SOME WRITES DID NOT LAND' : '\n  all writes verified; the PWA will show them on its next sync');
  process.exit(failed ? 1 : 0);
}

console.error(`unknown command: ${cmd}`); process.exit(2);
