/**
 * Real-model check: runs the game's own models (Human in Chrome, the same zoom crops as the game)
 * on real photos and clips of people in fixtures/real/ (python3 scripts/fetch-fixtures.py), then
 * scores what matters for play in Node with the app's own scoring code.
 *
 *     npm run realcheck [-- faces]
 *
 * Stage `faces`: several photos per person. Each photo can show bystanders, so the person's own face
 * is the one that recurs across their photos; every other face is a stranger. Reports same-person
 * and different-person centred similarity against FACE_CALIB. Results: .rubric/realcheck/.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { centredSimilarity } from '../src/vision/embedding.ts';
import { FACE_CALIB, MAX_YAW_DEG, MEAN_ALPHA, MIN_FACE_PX } from '../src/vision/calibration.ts';
import type { ProbeImage } from '../src/realcheck/probe.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FIX = join(ROOT, 'fixtures', 'real');
const OUT = join(ROOT, '.rubric', 'realcheck', ...(process.argv.find((a) => a.startsWith('--face=')) ? [process.argv.find((a) => a.startsWith('--face='))!.slice(7)] : []));
const PORT = 5198;
/** --face=<model>: a candidate face model from fixtures/models instead of the shipped one; results go to .rubric/realcheck/<model>/. */
const MODEL = process.argv.find((a) => a.startsWith('--face='))?.slice(7) ?? '';
const stages = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const want = (s: string) => stages.length === 0 || stages.includes(s);

async function startServer(): Promise<ChildProcess | null> {
  const up = async () => fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false);
  if (await up()) return null;
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, env: { ...process.env, VITE_HTTPS: '0', VITE_LOCAL_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) throw new Error('dev server did not start');
  return child;
}

async function openProbe(): Promise<Page> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  // Fixtures stay out of public/: serve them to the page from disk.
  await page.route('**/__fixtures/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__fixtures\//, ''));
    const base = rel.startsWith('models/') ? join(ROOT, 'fixtures') : FIX;
    const file = join(base, rel);
    if (!file.startsWith(base) || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.png') ? 'image/png' : file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.json') ? 'application/json' : file.endsWith('.bin') ? 'application/octet-stream' : 'image/jpeg' });
  });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${PORT}/?realcheck${MODEL ? `&face=${MODEL}` : ''}`);
  await page.waitForFunction(() => '__lzReal' in window, null, { timeout: 60_000 });
  const version = await page.evaluate(() => (window as unknown as { __lzReal: { ready(): Promise<string> } }).__lzReal.ready());
  console.log('models ready, Human', version);
  return page;
}

const probeVideo = (page: Page, src: string, fps: number) =>
  page.evaluate(([s, f]) => (window as unknown as { __lzReal: { probeVideo(s: string, f: number): Promise<(ProbeImage & { t: number })[]> } }).__lzReal.probeVideo(s, f), [src, fps] as const);

const probe = (page: Page, src: string) =>
  page.evaluate((s) => (window as unknown as { __lzReal: { probeImage(s: string): Promise<ProbeImage> } }).__lzReal.probeImage(s), src);

// ---- faces ----------------------------------------------------------------------------------------

interface Face {
  person: string;
  photo: string;
  px: number;
  yaw: number;
  box: [number, number, number, number];
  embedding: number[];
}

const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '  - ');
const share = (xs: number[], pred: (x: number) => boolean) => (xs.length ? Math.round((100 * xs.filter(pred).length) / xs.length) : 0);

/**
 * Which face in each photo is the person: the one most similar to faces in their other photos.
 * A face counts as them only if it recurs (similar to a face in at least two other photos), so a
 * photo where they are absent or turned away contributes only strangers.
 */
export function labelFaces(byPerson: Map<string, Face[][]>, recur = 0.4, minPhotos = 2) {
  const own: Face[] = [];
  const strangers: Face[] = [];
  for (const [, photos] of byPerson) {
    for (let i = 0; i < photos.length; i++) {
      let best: Face | null = null;
      let bestScore = -1;
      for (const f of photos[i]) {
        const support = photos.filter((other, j) => j !== i && other.some((g) => centredSimilarity(f.embedding, g.embedding) >= recur)).length;
        const mean = photos.flatMap((other, j) => (j === i ? [] : other.map((g) => centredSimilarity(f.embedding, g.embedding)))).sort((a, b) => b - a).slice(0, 3);
        const score = support + (mean.reduce((s, x) => s + x, 0) / Math.max(1, mean.length));
        if (support >= minPhotos && score > bestScore) {
          best = f;
          bestScore = score;
        }
      }
      for (const f of photos[i]) (f === best ? own : strangers).push(f);
    }
  }
  // Public figures stand in each other's photos: a "stranger" who recurs in another person's
  // photos is that person. Only faces that match nobody's recurring face stay strangers.
  const firm = recur + 0.1;
  const rest: Face[] = [];
  const moved: Face[] = [];
  for (const g of strangers) {
    let owner: string | null = null;
    for (const p of byPerson.keys()) {
      const photosHit = new Set(own.filter((f) => f.person === p && !(f.photo === g.photo && f.person === g.person) && centredSimilarity(f.embedding, g.embedding) >= firm).map((f) => f.photo));
      if (photosHit.size >= minPhotos) owner = p;
    }
    if (owner) moved.push({ ...g, person: owner, photo: `${g.person}/${g.photo}` });
    else rest.push(g);
  }
  return { own: [...own, ...moved], strangers: rest };
}

async function faces(page: Page) {
  const dir = join(FIX, 'stills');
  const people = readdirSync(dir).filter((d) => !d.startsWith('.')).sort();
  const byPerson = new Map<string, Face[][]>();
  const raw: Record<string, ProbeImage> = {};
  let ms = 0;
  let n = 0;
  for (const person of people) {
    const photos: Face[][] = [];
    for (const file of readdirSync(join(dir, person)).filter((f) => f.endsWith('.jpg')).sort()) {
      const r = await probe(page, `/__fixtures/stills/${person}/${file}`);
      raw[`${person}/${file}`] = r;
      ms += r.ms;
      n++;
      photos.push(
        r.faces
          .filter((f) => f.embedding.length && f.px >= MIN_FACE_PX && f.yaw <= MAX_YAW_DEG)
          .map((f) => ({ person, photo: file, px: Math.round(f.px), yaw: Math.round(f.yaw), box: f.box, embedding: f.embedding })),
      );
    }
    byPerson.set(person, photos);
    console.log(`${person}: ${photos.length} photos, ${photos.reduce((s, p) => s + p.length, 0)} usable faces`);
  }
  const { own, strangers } = labelFaces(byPerson);
  const genuine: number[] = [];
  const impostor: number[] = [];
  const worst: { a: string; b: string; sim: number }[] = [];
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const s = centredSimilarity(own[i].embedding, own[j].embedding);
      if (own[i].person === own[j].person) genuine.push(s);
      else {
        impostor.push(s);
        worst.push({ a: `${own[i].person}/${own[i].photo}`, b: `${own[j].person}/${own[j].photo}`, sim: s });
      }
    }
    for (const g of strangers) {
      if (g.photo === own[i].photo && g.person === own[i].person) continue;
      const s = centredSimilarity(own[i].embedding, g.embedding);
      impostor.push(s);
      worst.push({ a: `${own[i].person}/${own[i].photo}`, b: `stranger in ${g.person}/${g.photo}`, sim: s });
    }
  }
  // Nearest-profile identification, the way a round decides: each face against every other
  // person's photos (their "profile"), leave-one-photo-out.
  let top1 = 0;
  let accepted = 0;
  let wrongAccepted = 0;
  for (const f of own) {
    const scores = [...byPerson.keys()].map((p) => ({
      p,
      s: Math.max(0, ...own.filter((g) => g.person === p && g.photo !== f.photo).map((g) => centredSimilarity(f.embedding, g.embedding))),
    }));
    scores.sort((a, b) => b.s - a.s);
    if (scores[0].p === f.person) top1++;
    if (scores[0].s >= FACE_CALIB.accept) {
      accepted++;
      if (scores[0].p !== f.person) wrongAccepted++;
    }
  }
  let strangerAccepted = 0;
  for (const g of strangers) {
    const best = Math.max(0, ...own.filter((f) => f.photo !== g.photo || f.person !== g.person).map((f) => centredSimilarity(f.embedding, g.embedding)));
    if (best >= FACE_CALIB.accept) strangerAccepted++;
  }
  worst.sort((a, b) => b.sim - a.sim);
  const summary = {
    photos: n,
    msPerPhoto: Math.round(ms / Math.max(1, n)),
    people: people.length,
    ownFaces: own.length,
    strangerFaces: strangers.length,
    calib: FACE_CALIB,
    genuine: { n: genuine.length, p10: pct(genuine, 10), p50: pct(genuine, 50), p90: pct(genuine, 90), aboveAccept: share(genuine, (x) => x >= FACE_CALIB.accept), belowReject: share(genuine, (x) => x < FACE_CALIB.reject) },
    impostor: { n: impostor.length, p50: pct(impostor, 50), p90: pct(impostor, 90), p99: pct(impostor, 99), max: pct(impostor, 100), aboveReject: share(impostor, (x) => x >= FACE_CALIB.reject), aboveAccept: impostor.filter((x) => x >= FACE_CALIB.accept).length },
    identify: { faces: own.length, top1Pct: Math.round((100 * top1) / Math.max(1, own.length)), acceptedPct: Math.round((100 * accepted) / Math.max(1, own.length)), wrongAccepted, strangersAccepted: strangerAccepted },
    worstImpostors: worst.slice(0, 8),
  };
  writeFileSync(join(OUT, 'faces.json'), JSON.stringify({ summary, own: own.map(({ embedding: _e, ...f }) => f), raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { ...v, faces: v.faces.map(({ embedding: _e, ...f }) => f) }])) }, null, 1));
  writeFileSync(join(OUT, 'embeddings.json'), JSON.stringify({ own, strangers }));
  console.log(`\nfaces: ${n} photos of ${people.length} people, ${Math.round(ms / Math.max(1, n))} ms each; ${own.length} own faces, ${strangers.length} strangers`);
  console.log(`same person   n=${genuine.length}  p10 ${f2(summary.genuine.p10)}  p50 ${f2(summary.genuine.p50)}  p90 ${f2(summary.genuine.p90)}  ≥accept ${summary.genuine.aboveAccept}%  <reject ${summary.genuine.belowReject}%`);
  console.log(`different     n=${impostor.length}  p50 ${f2(summary.impostor.p50)}  p90 ${f2(summary.impostor.p90)}  p99 ${f2(summary.impostor.p99)}  max ${f2(summary.impostor.max)}  ≥reject ${summary.impostor.aboveReject}%  ≥accept ${summary.impostor.aboveAccept}`);
  console.log(`identify      top-1 ${summary.identify.top1Pct}%  accepted ${summary.identify.acceptedPct}%  wrong accepted ${wrongAccepted}  strangers accepted ${strangerAccepted}`);
  console.log('closest different pairs:', worst.slice(0, 4).map((w) => `${f2(w.sim)} ${w.a} ~ ${w.b}`).join('\n  '));
  return summary;
}

// ---- clips ---------------------------------------------------------------------------------------

/** Seconds of each talker clip used as the enrolment scan; the rest plays the round. */
const ENROL_S = 6;

/**
 * Single-person talker clips: enrol each person from the first seconds (up to eight samples, as the
 * scan keeps), then score every later frame against every profile with the game's best-of-profile
 * rule. Same-session genuine scores are what a round sees; other people's clips and the photo set's
 * faces are the impostors.
 */
async function clips(page: Page) {
  const dir = join(FIX, 'clips');
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('talker-') && f.endsWith('.mp4')).sort() : [];
  if (names.length < 1) {
    console.log('clips: no talker clips in fixtures/real/clips');
    return null;
  }
  const people: { name: string; profile: number[][]; live: { t: number; px: number; yaw: number; e: number[] }[] }[] = [];
  for (const file of names) {
    const frames = await probeVideo(page, `/__fixtures/clips/${file}`, 5);
    const main = frames
      .map((f) => ({ t: f.t, face: [...f.faces].filter((x) => x.embedding.length).sort((a, b) => b.px - a.px)[0] }))
      .filter((x) => x.face && x.face.px >= MIN_FACE_PX && x.face.yaw <= MAX_YAW_DEG);
    const enrol = main.filter((x) => x.t < ENROL_S);
    // Spread the eight samples over the enrolment window.
    const step = Math.max(1, Math.floor(enrol.length / 8));
    const profile = enrol.filter((_, i) => i % step === 0).slice(0, 8).map((x) => x.face.embedding);
    const live = main.filter((x) => x.t >= ENROL_S + 1).map((x) => ({ t: x.t, px: Math.round(x.face.px), yaw: Math.round(x.face.yaw), e: x.face.embedding }));
    people.push({ name: file.replace(/\.mp4$/, ''), profile, live });
    console.log(`${file}: ${frames.length} frames, ${main.length} usable faces, profile ${profile.length}, live ${live.length}`);
  }
  const best = (e: number[], profile: number[][]) => Math.max(0, ...profile.map((f) => centredSimilarity(e, f)));
  const genuine: number[] = [];
  const impostor: number[] = [];
  let top1 = 0;
  let total = 0;
  let margins: number[] = [];
  for (const p of people) {
    for (const l of p.live) {
      const scores = people.map((q) => ({ id: q.name, s: best(l.e, q.profile) })).sort((a, b) => b.s - a.s);
      genuine.push(best(l.e, p.profile));
      for (const q of people) if (q !== p) impostor.push(best(l.e, q.profile));
      total++;
      if (scores[0].id === p.name) top1++;
      margins.push(best(l.e, p.profile) - Math.max(0, ...people.filter((q) => q !== p).map((q) => best(l.e, q.profile))));
    }
  }
  // The game matches a track's running face mean, not the single frame (scoring.ts updateFaceMean).
  const meanGenuine: number[] = [];
  for (const p of people) {
    let m: number[] | null = null;
    let n = 0;
    for (const l of p.live) {
      const a = Math.max(MEAN_ALPHA, 1 / (n + 1));
      m = m ? unit(m.map((v, i) => (1 - a) * v + a * l.e[i])) : l.e.slice();
      n++;
      if (n >= 3) meanGenuine.push(best(m, p.profile));
    }
  }
  // Photo-set faces (people who never enrolled) against every talker profile: strangers in the room.
  let strangerFaces = 0;
  let strangerAccepted = 0;
  const strangerScores: number[] = [];
  if (existsSync(join(OUT, 'embeddings.json'))) {
    const d = JSON.parse(readFileSync(join(OUT, 'embeddings.json'), 'utf8')) as { own: Face[]; strangers: Face[] };
    for (const f of [...d.own, ...d.strangers]) {
      const s = Math.max(...people.map((p) => best(f.embedding, p.profile)));
      strangerScores.push(s);
      strangerFaces++;
      if (s >= FACE_CALIB.accept) strangerAccepted++;
    }
  }
  const summary = {
    people: people.map((p) => ({ name: p.name, profile: p.profile.length, live: p.live.length })),
    genuine: { n: genuine.length, p5: pct(genuine, 5), p10: pct(genuine, 10), p50: pct(genuine, 50), aboveAccept: share(genuine, (x) => x >= FACE_CALIB.accept) },
    impostor: { n: impostor.length, p50: pct(impostor, 50), p99: pct(impostor, 99), max: pct(impostor, 100), aboveAccept: impostor.filter((x) => x >= FACE_CALIB.accept).length },
    trackMean: { n: meanGenuine.length, p5: pct(meanGenuine, 5), p10: pct(meanGenuine, 10), p50: pct(meanGenuine, 50), aboveAccept: share(meanGenuine, (x) => x >= FACE_CALIB.accept) },
    top1Pct: Math.round((100 * top1) / Math.max(1, total)),
    margin: { p5: pct(margins, 5), p50: pct(margins, 50) },
    strangers: { n: strangerFaces, p99: pct(strangerScores, 99), max: pct(strangerScores, 100), accepted: strangerAccepted },
  };
  console.log(`\nclips: ${people.length} enrolled talkers, same-session live frames scored against every profile`);
  console.log(`same person   n=${genuine.length}  p5 ${f2(summary.genuine.p5)}  p10 ${f2(summary.genuine.p10)}  p50 ${f2(summary.genuine.p50)}  ≥accept ${summary.genuine.aboveAccept}%`);
  console.log(`track mean    n=${meanGenuine.length}  p5 ${f2(summary.trackMean.p5)}  p10 ${f2(summary.trackMean.p10)}  p50 ${f2(summary.trackMean.p50)}  ≥accept ${summary.trackMean.aboveAccept}%`);
  console.log(`other player  n=${impostor.length}  p50 ${f2(summary.impostor.p50)}  p99 ${f2(summary.impostor.p99)}  max ${f2(summary.impostor.max)}  ≥accept ${summary.impostor.aboveAccept}`);
  console.log(`strangers     n=${strangerFaces}  p99 ${f2(summary.strangers.p99)}  max ${f2(summary.strangers.max)}  ≥accept ${strangerAccepted}`);
  console.log(`identify      top-1 ${summary.top1Pct}%  margin p5 ${f2(summary.margin.p5)} p50 ${f2(summary.margin.p50)}`);
  writeFileSync(join(OUT, 'clips.json'), JSON.stringify({ summary, people }, null, 0));
  return summary;
}

// ---- shoot ---------------------------------------------------------------------------------------

/**
 * Real group photos through the tracking bench (src/bench): the real models and the real pipeline
 * on several real people in one frame, a drifting virtual camera, a shot every 1.3 s aimed at each
 * person in turn. The bench enrols everyone from the photo itself, so identity is easy here; what is
 * tested is who is under the dot among real, overlapping bodies. Wrong must be 0.
 */
async function shoot(page: Page) {
  const raw = JSON.parse(readFileSync(join(OUT, 'faces.json'), 'utf8')).raw as Record<string, { faces: { px: number; yaw: number }[]; bodies: number }>;
  // Game-like scenes: at least two people with a detected body (seated rows behind tables are refused
  // by design, a hit needs an observed torso) and two faces large enough to enrol.
  const groups = Object.entries(raw)
    .filter(([, r]) => r.bodies >= 2 && r.faces.filter((f) => f.px >= 60 && f.yaw <= MAX_YAW_DEG).length >= 2)
    .map(([k]) => k)
    .sort();
  const pick = groups.filter((_, i) => i % Math.max(1, Math.floor(groups.length / 12)) === 0).slice(0, 12);
  const rows: Record<string, unknown>[] = [];
  const total = { shots: 0, correct: 0, wrong: 0, unclear: 0, miss: 0, offTarget: 0, wrongLockFrames: 0 };
  for (const photo of pick) {
    for (let target = 0; target < 2; target++) {
      await page.goto(`http://localhost:${PORT}/?bench&auto=drift&photo=${encodeURIComponent(`/__fixtures/stills/${photo}`)}&target=${target}`);
      let stats: Record<string, number> | null = null;
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(500);
        stats = await page.evaluate(() => (window as unknown as { __bench?: { stats(): Record<string, number> } }).__bench?.stats() ?? null);
        if (stats && stats.shots >= 12) break;
      }
      const people = await page.evaluate(() => (window as unknown as { __bench?: { people(): unknown[] } }).__bench?.people().length ?? 0);
      if (!stats || people < 2) continue;
      rows.push({ photo, target, people, ...stats });
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += stats[k] ?? 0;
      console.log(`${photo} target ${target}: ${people} people, shots ${stats.shots} correct ${stats.correct} wrong ${stats.wrong} unclear ${stats.unclear} miss ${stats.miss} off ${stats.offTarget} wrongLock ${stats.wrongLockFrames} period ${stats.periodMs} ms`);
    }
  }
  console.log(`\nshoot: ${rows.length} runs, ${total.shots} shots: correct ${total.correct}, wrong ${total.wrong}, unclear ${total.unclear}, miss ${total.miss}, off-target ${total.offTarget}, wrong-lock frames ${total.wrongLockFrames}`);
  writeFileSync(join(OUT, 'shoot.json'), JSON.stringify({ total, rows }, null, 1));
  return total;
}

async function main() {
  if (!existsSync(FIX)) throw new Error('no fixtures: run python3 scripts/fetch-fixtures.py first');
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const page = await openProbe();
  const result: Record<string, unknown> = { at: new Date().toISOString() };
  try {
    if (want('faces')) result.faces = await faces(page);
    if (want('clips')) result.clips = await clips(page);
    if (want('shoot')) result.shoot = await shoot(page);
  } finally {
    await page.context().browser()?.close();
    server?.kill();
  }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(result, null, 1));
  // The gate: the outcomes the game must never produce.
  const shot = result.shoot as { wrong: number; wrongLockFrames: number } | undefined;
  if (shot && (shot.wrong > 0 || shot.wrongLockFrames > 0)) {
    console.error(`FAIL: ${shot.wrong} wrong hits, ${shot.wrongLockFrames} wrong-lock frames on real photos`);
    process.exitCode = 1;
  }
}

await main();
