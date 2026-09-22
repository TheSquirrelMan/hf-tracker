// Parity test: the extracted engine (engine.mjs, closure scope) vs the in-page engine
// (same function bodies, original global scope). The bodies are byte-identical, so what
// this actually tests is the SCOPE REWIRING — a global that was missed or wired wrong.
//
// Usage: node tools/parity.mjs <state.json>
import { readFileSync } from 'fs';
import { createEngine, DEFAULT_PHASES, MN, DN } from '../engine.mjs';

const statePath = process.argv[2];
if (!statePath) { console.error('usage: node tools/parity.mjs <state.json>'); process.exit(2); }
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

const PURE = ['getPhases','isoDay','bal','jonPaidThisPeriod','isKarenPayday','getDailyBills',
              'getSnowballTargets','calcRoadmap','getMonthEvents','toMonthlyAmt'];

function grab(name) {
  const m = new RegExp(`(?:^|\\n)function\\s+${name}\\s*\\(`).exec(js);
  if (!m) throw new Error(`missing ${name}`);
  let i = js.indexOf('{', m.index + m[0].length - 1), d = 0;
  for (let j = i; j < js.length; j++) {
    if (js[j] === '{') d++;
    else if (js[j] === '}' && --d === 0) return [m.index, js.slice(m.index, j + 1)];
  }
  throw new Error(`unbalanced ${name}`);
}
const parts = PURE.map(grab);
const pa = /const phaseAmt\s*=\s*\([\s\S]*?\n/.exec(js);
parts.push([pa.index, pa[0]]);
parts.sort((a, b) => a[0] - b[0]);

// legacy: original global scope, globals injected as parameters (how the page ran it)
function legacyEngine(state, nowDate) {
  const names = ['S','now','mKey','MN','DN','DEFAULT_PHASES','DEFAULT_USER_BILLS'];
  const vals  = [state, nowDate, `${nowDate.getFullYear()}-${nowDate.getMonth()}`,
                 MN, DN, DEFAULT_PHASES, []];
  const src = `let _cachedRoadmap=null,_roadmapCacheKey='';\n`
            + parts.map(p => p[1]).join('\n')
            + `\nreturn {${PURE.join(',')},phaseAmt};`;
  return new Function(...names, src)(...vals);
}

const DATES = ['2026-09-21','2026-09-26','2026-09-30','2026-10-01','2026-12-31','2027-02-14'];
let fail = 0;
for (const d of DATES) {
  const when = new Date(d + 'T10:00:00');
  const A = legacyEngine(JSON.parse(JSON.stringify(state)), when);
  const B = createEngine({ state: JSON.parse(JSON.stringify(state)), now: when });
  const ra = A.calcRoadmap(), rb = B.calcRoadmap();
  const checks = {
    milestones: [ra.milestones, rb.milestones],
    balLog:     [ra.balLog, rb.balLog],
    sinkingLog: [ra.sinkingLog, rb.sinkingLog],
    finalCardBals: [ra.finalCardBals, rb.finalCardBals],
    monthEvents: [A.getMonthEvents(when.getFullYear(), when.getMonth(), ra.milestones, ra.balLog, ra.sinkingLog),
                  B.getMonthEvents(when.getFullYear(), when.getMonth(), rb.milestones, rb.balLog, rb.sinkingLog)],
    dailyBills: [A.getDailyBills(when.getFullYear(), when.getMonth(), when.getDate()),
                 B.getDailyBills(when.getFullYear(), when.getMonth(), when.getDate())],
    snowballTargets: [A.getSnowballTargets(), B.getSnowballTargets()],
  };
  const bad = Object.entries(checks)
    .filter(([, [x, y]]) => JSON.stringify(x) !== JSON.stringify(y))
    .map(([k]) => k);
  const nMs = Object.keys(ra.milestones || {}).length;
  const nBl = Object.keys(ra.balLog || {}).length;
  if (bad.length) { fail++; console.log(`  ${d}  MISMATCH: ${bad.join(', ')}`); }
  else console.log(`  ${d}  identical  (milestones=${nMs}, balLog=${nBl} days)`);
}
console.log(fail ? `\nPARITY FAILED on ${fail}/${DATES.length} dates` : `\nPARITY OK across ${DATES.length} dates`);
process.exit(fail ? 1 : 0);
