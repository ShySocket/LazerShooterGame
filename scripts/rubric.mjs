#!/usr/bin/env node
/**
 * Scores the app against docs/tracking-rubric.md and prints the result out of 100.
 *
 *   npm run rubric                 sim (3 seeds) + unit tests + build + e2e results + recorded evidence
 *   npm run rubric -- --seeds 100  slower, closer to the strict sweep
 *   npm run rubric -- --quick      sim only; tests and build count as UNTESTED
 *   npm run rubric -- --no-log     do not append to docs/rubric-scores.md
 *
 * Every scored rubric line carries `<!-- Rn.nn evidence -->`. Evidence kinds:
 *   auto:sim.<check>   a predicate on the simulation aggregates (tests/sim/engine.ts), see SIM_CHECKS
 *   auto:test:<name>   a unit test whose name contains <name> passed (node --test, TAP reporter)
 *   auto:build         `npm run build` exits 0
 *   auto:validate      scripts/validate.mjs on recordings/ exits 0 with at least 200 labelled taps
 *   e2e:<name>         .rubric/e2e.json (written by `npm run e2e`) reports that test as passed
 *   auto:realcheck     .rubric/realcheck/shoot.json (npm run realcheck -- shoot) has 0 wrong hits and 0 wrong-lock frames
 *   auto:simwide       .rubric/sim-wide.json (npm run sim:wide) covers at least 1000 seeds with no wrong outcome beyond the documented residuals
 *   phone | manual     docs/rubric-status.json records {status, date, note} for the id
 *
 * Score: Must items share 70 points, Should 25, Nice 5; an UNTESTED item scores 0 like a FAIL.
 * The Must-only score is what "basic requirements" means for the demo.
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const seedCount = Number(opt('--seeds', 3));
const quick = flag('--quick');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const at = (...p) => resolve(root, ...p);

await import(pathToFileURL(at('tests/register.mjs')).href);
const { aggregate, SCENARIOS } = await import('../tests/sim/engine.ts');
const { CALIBRATION_VERSION } = await import('../src/vision/calibration.ts');

// ---- Rubric --------------------------------------------------------------------------------------
const rubric = readFileSync(at('docs/tracking-rubric.md'), 'utf8').split('\n');
const items = [];
const untagged = [];
let section = null;
for (const line of rubric) {
  const h = line.match(/^## (\d+)\. (.*)$/);
  if (h) section = { n: Number(h[1]), title: h[2] };
  const m = line.match(/^- \[[ x]\] \*\*(Must|Should|Nice)\*\*: (.*?)\s*(?:<!--\s*(R\d+\.\d+)\s+(.+?)\s*-->)?\s*$/);
  if (!m || !section) continue;
  if (!m[3]) { untagged.push(`${section.n}: ${m[2].slice(0, 60)}`); continue; }
  items.push({ id: m[3], tier: m[1], text: m[2], tag: m[4], section: section.n, sectionTitle: section.title });
}
if (untagged.length) console.warn(`WARNING: ${untagged.length} tiered line(s) without an id/evidence tag:\n  ${untagged.join('\n  ')}`);

// ---- Evidence ------------------------------------------------------------------------------------
const need = (prefix) => items.some((i) => i.tag.startsWith(prefix));
const evidence = { sim: null, tests: null, build: null, validate: null, e2e: null, status: null };

if (need('auto:sim.')) {
  const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);
  evidence.sim = {};
  process.stdout.write(`sim: ${SCENARIOS.length} scenarios x ${seeds.length} seeds `);
  for (const s of SCENARIOS) {
    evidence.sim[s.name] = await aggregate(s, seeds);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
}

if (need('auto:test:') && !quick) {
  const files = readdirSync(at('tests')).filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
  process.stdout.write('tests: ');
  const r = spawnSync(process.execPath, ['--import', './tests/register.mjs', '--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const passed = [];
  const failed = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^\s*(not )?ok \d+ - (.*)$/);
    if (!m) continue;
    (m[1] ? failed : passed).push(m[2].replace(/\s*#.*$/, ''));
  }
  evidence.tests = { passed, failed, exit: r.status };
  console.log(`${passed.length} passed, ${failed.length} failed`);
}

if (need('auto:build') && !quick) {
  process.stdout.write('build: ');
  const r = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  evidence.build = { ok: r.status === 0, tail: (r.stdout + r.stderr).split('\n').slice(-3).join(' ') };
  console.log(evidence.build.ok ? 'ok' : 'FAILED');
}

if (need('auto:validate')) {
  const folder = opt('--recordings', 'recordings');
  if (existsSync(at(folder))) {
    process.stdout.write(`validate: ${folder} `);
    const r = spawnSync(process.execPath, ['scripts/validate.mjs', folder], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
    const m = (r.stdout ?? '').match(/Total: correct (\d+)\/(\d+)/);
    evidence.validate = { exit: r.status, correct: m ? Number(m[1]) : 0, labelled: m ? Number(m[2]) : 0 };
    console.log(`exit ${r.status}, ${evidence.validate.labelled} labelled`);
  } else {
    evidence.validate = { missing: folder };
  }
}

if (need('e2e:') && existsSync(at('.rubric/e2e.json'))) {
  try { evidence.e2e = JSON.parse(readFileSync(at('.rubric/e2e.json'), 'utf8')); } catch (e) { console.warn('e2e.json unreadable: ' + e.message); }
}
if (existsSync(at('docs/rubric-status.json'))) {
  try { evidence.status = JSON.parse(readFileSync(at('docs/rubric-status.json'), 'utf8')); } catch (e) { console.warn('rubric-status.json unreadable: ' + e.message); }
}

// ---- Checks --------------------------------------------------------------------------------------
const rate = (a) => a.correct / Math.max(1, a.possible);
const pct = (x) => `${Math.round(100 * x)}%`;
const all = (names, pred) => names.map((n) => [n, evidence.sim[n]]).filter(([, a]) => !a || !pred(a)).map(([n]) => n);
const clean = (a) => a.wrong === 0 && a.wrongLockFrames === 0;
const one = (name, pred, describe) => {
  const a = evidence.sim[name];
  if (!a) return { ok: false, detail: `no scenario ${name}` };
  return { ok: pred(a), detail: describe(a) };
};
const SAFE = ['crossing', 'pan-crossing', 'crossing-backs', 'occlusion', 'identical-tops', 'stranger', 'mirror', 'same-shirt-stranger', 'lookalike-faces'];
const noPlayer = (name) => one(name, (a) => a.correct + a.wrong === 0 && a.wrongLockFrames === 0 && a.maybeOnNonPlayer === 0, (a) => `hits ${a.correct + a.wrong}, wrongLock ${a.wrongLockFrames}, maybeNP ${a.maybeOnNonPlayer}`);
const hitAndClean = (name, min) => one(name, (a) => a.wrong === 0 && rate(a) >= min, (a) => `hit ${pct(rate(a))} (>= ${pct(min)}), wrong ${a.wrong}`);
const SIM_CHECKS = {
  wrong0: () => { const bad = all(Object.keys(evidence.sim), (a) => a.wrong === 0); return { ok: !bad.length, detail: bad.length ? `wrong hits in ${bad.join(', ')}` : `0 wrong over ${Object.keys(evidence.sim).length} scenarios` }; },
  wrongLock0: () => { const bad = all(SAFE, (a) => a.wrongLockFrames === 0); return { ok: !bad.length, detail: bad.length ? `wrong-lock frames in ${bad.join(', ')}` : `0 wrong-lock frames in ${SAFE.length} scenarios` }; },
  stranger: () => noPlayer('stranger'),
  sameShirt: () => noPlayer('same-shirt-stranger'),
  mirror: () => noPlayer('mirror'),
  identicalTops: () => one('identical-tops', clean, (a) => `wrong ${a.wrong}, wrongLock ${a.wrongLockFrames}`),
  // The hit floor only guards against refusing everything; it matches tests/sim.test.ts's bound on the
  // same three hard seeds (26 of 33 since 2026-10-01.8; 96% over 1000 seeds, npm run sim:wide).
  occlusion: () => one('occlusion', (a) => clean(a) && rate(a) >= 0.75, (a) => `wrong ${a.wrong}, wrongLock ${a.wrongLockFrames}, hit ${pct(rate(a))}`),
  ambiguous: () => {
    const zero = ['duel-close', 'stranger', 'mirror', 'same-shirt-stranger', 'identical-tops', 'slow-phone', 'dim-light'];
    const ceilings = { occlusion: 0.2, 'range-8m': 0.12, crossing: 0.08, 'pan-crossing': 0.08, 'back-shot': 0.08, 'turn-around': 0.08, 'lookalike-faces': 0.08 };
    const bad = [...all(zero, (a) => a.ambiguous === 0), ...Object.entries(ceilings).filter(([n, c]) => !evidence.sim[n] || evidence.sim[n].ambiguous / Math.max(1, evidence.sim[n].shots) > c).map(([n]) => n)];
    return { ok: !bad.length, detail: bad.length ? `ambiguous over ceiling in ${bad.join(', ')}` : 'ambiguous within ceilings' };
  },
  duelChurn: () => one('duel-close', (a) => a.trackChurn <= 2, (a) => `tracks ${a.trackChurn.toFixed(1)} (<= 2)`),
  turnAround: () => one('turn-around', (a) => a.wrong === 0 && rate(a) >= 0.85 && a.trackChurn <= 2, (a) => `hit ${pct(rate(a))}, wrong ${a.wrong}, tracks ${a.trackChurn.toFixed(1)}`),
  flakyPose: () => one('flaky-pose', (a) => a.wrong === 0 && rate(a) >= 0.8 && a.trackChurn <= 4, (a) => `hit ${pct(rate(a))}, wrong ${a.wrong}, tracks ${a.trackChurn.toFixed(1)}`),
  crossings: () => { const bad = all(['crossing', 'crossing-backs'], clean); return { ok: !bad.length, detail: bad.length ? `swap in ${bad.join(', ')}` : 'crossing and crossing-backs clean' }; },
  firstLock: () => one('duel-close', (a) => a.firstLockMs !== null && a.firstLockMs < 1500, (a) => `first lock ${a.firstLockMs === null ? 'never' : Math.round(a.firstLockMs) + ' ms'} (< 1500)`),
  panCrossing: () => one('pan-crossing', (a) => clean(a) && rate(a) >= 0.35, (a) => `hit ${pct(rate(a))} (>= 35%), wrong ${a.wrong}, wrongLock ${a.wrongLockFrames}`),
  duelHit: () => hitAndClean('duel-close', 0.9),
  backShot: () => hitAndClean('back-shot', 0.75),
  range8m: () => hitAndClean('range-8m', 0.6),
  lookalikeTops: () => hitAndClean('lookalike-tops', 0.5),
  lookalikeFaces: () => one('lookalike-faces', clean, (a) => `wrong ${a.wrong}, wrongLock ${a.wrongLockFrames}, hit ${pct(rate(a))}`),
  approach: () => hitAndClean('approach', 0.85),
  dimLight: () => hitAndClean('dim-light', 0.8),
  slowPhone: () => {
    const s = evidence.sim['slow-phone'];
    const h = evidence.sim['hiccups'];
    if (!s || !h) return { ok: false, detail: 'missing scenario' };
    return { ok: s.stale === 0 && s.wrong === 0 && rate(s) >= 0.85 && h.stale <= 1 && h.wrong === 0, detail: `slow-phone stale ${s.stale}, hit ${pct(rate(s))}; hiccups stale ${h.stale}` };
  },
};

function judge(item) {
  const [kind, ...rest] = item.tag.split(':');
  const arg = rest.join(':');
  if (kind === 'auto' && arg.startsWith('sim.')) {
    if (!evidence.sim) return ['UNTESTED', 'sim not run'];
    const check = SIM_CHECKS[arg.slice(4)];
    if (!check) return ['UNTESTED', `unknown sim check ${arg}`];
    const r = check();
    return [r.ok ? 'PASS' : 'FAIL', r.detail];
  }
  if (kind === 'auto' && arg.startsWith('test:')) {
    const name = arg.slice(5);
    if (!evidence.tests) return ['UNTESTED', 'tests skipped (--quick)'];
    if (evidence.tests.failed.some((n) => n.includes(name))) return ['FAIL', `test failed: ${name}`];
    if (evidence.tests.passed.some((n) => n.includes(name))) return ['PASS', `test passed: ${name}`];
    return ['UNTESTED', `no test named "${name}"`];
  }
  if (kind === 'auto' && arg === 'build') {
    if (!evidence.build) return ['UNTESTED', 'build skipped (--quick)'];
    return [evidence.build.ok ? 'PASS' : 'FAIL', evidence.build.ok ? 'npm run build ok' : evidence.build.tail];
  }
  if (kind === 'auto' && arg === 'validate') {
    const v = evidence.validate;
    if (!v || v.missing) return ['UNTESTED', `no ${v?.missing ?? 'recordings'}/ folder (docs/validation.md)`];
    if (v.exit === 1) return ['FAIL', 'validate.mjs found a wrong hit'];
    if (v.labelled < 200) return ['UNTESTED', `${v.labelled} labelled taps, need 200`];
    return [v.exit === 0 ? 'PASS' : 'FAIL', `exit ${v.exit}, ${v.correct}/${v.labelled} correct, 0 wrong`];
  }
  if (kind === 'auto' && arg === 'simwide') {
    // Written by `npm run sim:wide` (tests/sim/wide.ts); too slow for CI.
    const f = at('.rubric/sim-wide.json');
    if (!existsSync(f)) return ['UNTESTED', 'no .rubric/sim-wide.json (npm run sim:wide)'];
    const w = JSON.parse(readFileSync(f, 'utf8'));
    const ok = w.seeds >= 1000 && w.unexpected === 0;
    const known = w.rows.flatMap((r) => r.wrongSeeds.map((s) => `${r.scenario} ${s}`));
    return [ok ? 'PASS' : 'FAIL', `${w.seeds} seeds from ${w.firstSeed} at ${w.sha}: ${w.unexpected} unexpected wrong outcome(s); documented residuals ${known.join(', ') || 'none'}`];
  }
  if (kind === 'auto' && arg === 'realcheck') {
    // Written by `npm run realcheck -- shoot` (needs the fixtures from `npm run fixtures`).
    const f = at('.rubric/realcheck/shoot.json');
    if (!existsSync(f)) return ['UNTESTED', 'no .rubric/realcheck/shoot.json (npm run fixtures, then npm run realcheck -- shoot)'];
    const { total } = JSON.parse(readFileSync(f, 'utf8'));
    const ok = total.wrong === 0 && total.wrongLockFrames === 0 && total.shots > 0;
    return [ok ? 'PASS' : 'FAIL', `${total.shots} real-photo shots: ${total.correct} correct, ${total.wrong} wrong, ${total.wrongLockFrames} wrong-lock frames`];
  }
  if (kind === 'e2e') {
    const t = evidence.e2e?.tests?.[arg];
    if (!t) return ['UNTESTED', evidence.e2e ? `no e2e result named ${arg}` : 'no .rubric/e2e.json (npm run e2e)'];
    return [t.status === 'pass' ? 'PASS' : 'FAIL', `e2e ${arg} ${t.status}${t.note ? ': ' + t.note : ''}`];
  }
  if (kind === 'phone' || kind === 'manual') {
    const s = evidence.status?.[item.id];
    if (!s || s.status === 'untested') return ['UNTESTED', s?.note ?? `${kind} evidence not recorded`];
    return [s.status === 'pass' ? 'PASS' : 'FAIL', `${s.date ?? ''} ${s.note ?? ''}`.trim()];
  }
  return ['UNTESTED', `unknown evidence kind ${item.tag}`];
}

for (const it of items) [it.status, it.detail] = judge(it);

// ---- Score ---------------------------------------------------------------------------------------
const WEIGHTS = { Must: 70, Should: 25, Nice: 5 };
const tierScore = (tier) => {
  const of = items.filter((i) => i.tier === tier);
  const pass = of.filter((i) => i.status === 'PASS').length;
  return { pass, count: of.length, points: of.length ? (WEIGHTS[tier] * pass) / of.length : 0 };
};
const tiers = Object.fromEntries(Object.keys(WEIGHTS).map((t) => [t, tierScore(t)]));
const total = Object.values(tiers).reduce((s, t) => s + t.points, 0);
const must = tiers.Must;
const mustAuto = items.filter((i) => i.tier === 'Must' && !/^(phone|manual|auto:validate)/.test(i.tag));
const mustAutoPass = mustAuto.filter((i) => i.status === 'PASS').length;

const mark = { PASS: 'PASS', FAIL: 'FAIL', UNTESTED: '----' };
console.log('');
for (const n of [...new Set(items.map((i) => i.section))]) {
  const of = items.filter((i) => i.section === n);
  console.log(`## ${n}. ${of[0].sectionTitle}  (${of.filter((i) => i.status === 'PASS').length}/${of.length})`);
  for (const i of of) console.log(`  ${mark[i.status]}  ${i.id}  ${i.tier.padEnd(6)} ${i.detail}`);
}
console.log('');
console.log(`Rubric score: ${total.toFixed(1)}/100   Must ${must.pass}/${must.count} (${must.points.toFixed(1)}/70)   Should ${tiers.Should.pass}/${tiers.Should.count}   Nice ${tiers.Nice.pass}/${tiers.Nice.count}`);
console.log(`Basic requirements (Must) verifiable without a phone: ${mustAutoPass}/${mustAuto.length}; needing a phone: ${must.count - mustAuto.length}`);
const open = items.filter((i) => i.tier === 'Must' && i.status !== 'PASS');
if (open.length) {
  console.log('\nMust items not yet green:');
  for (const i of open) console.log(`  ${mark[i.status]}  ${i.id}  [${i.tag}]  ${i.text.slice(0, 90)}${i.text.length > 90 ? '…' : ''}`);
}

const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
mkdirSync(at('.rubric'), { recursive: true });
writeFileSync(at('.rubric/last.json'), JSON.stringify({ date, sha, calibration: CALIBRATION_VERSION, seeds: seedCount, total, tiers, items }, null, 2));
if (!flag('--no-log')) {
  const log = at('docs/rubric-scores.md');
  if (!existsSync(log)) writeFileSync(log, '# Rubric scores\n\nOne line per `npm run rubric` run that was worth keeping (versions are the merged PRs). Score = Must 70 + Should 25 + Nice 5.\n\n| date | sha | calibration | seeds | score | Must | Should | Nice | note |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n');
  appendFileSync(log, `| ${date} | ${sha} | ${CALIBRATION_VERSION} | ${seedCount}${quick ? ' quick' : ''} | ${total.toFixed(1)} | ${must.pass}/${must.count} | ${tiers.Should.pass}/${tiers.Should.count} | ${tiers.Nice.pass}/${tiers.Nice.count} | ${opt('--note', '')} |\n`);
}
process.exit(0);
