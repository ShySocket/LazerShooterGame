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
 * The faces and clips summaries also record msPerCrop, the median time of one face's zoom crop pass
 * (crop + face detector + mesh + embedding model) in this headless Chrome, for comparing models.
 *
 * Environment (all optional): LZ_FIXTURES, the fixtures directory holding real/ and models/ (default
 * fixtures/, e.g. the main checkout's from a worktree); LZ_REALCHECK_OUT, the results directory
 * (default .rubric/realcheck; --face=<model> writes to its <model>/ subdirectory); LZ_REALCHECK_PORT,
 * the dev server port (default 5198; a server already listening there is reused, so give a worktree
 * its own port).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { centredSimilarity } from '../src/vision/embedding.ts';
import { FACE_CALIB, MAX_YAW_DEG, MEAN_ALPHA, MIN_FACE_PX } from '../src/vision/calibration.ts';
import type { ProbeImage } from '../src/realcheck/probe.ts';
import { FACE_PROMPTS, faceStageStep, holdStep, initialFaceStage, initialScanState, judgePose, skipFaceAngle, type FaceObs, type ScanState } from '../src/vision/scan.ts';
import { FACE_SAMPLES } from '../src/vision/embedding.ts';
import { formatShootBounds, shootBounds, type ShootRun } from '../src/feedback/stats.ts';

const ROOT = resolve(import.meta.dirname, '..');
/** The fixtures directory: real/ (photos, clips, extracted frames) and models/ (candidate face models). */
const FIXTURES = process.env.LZ_FIXTURES ? resolve(process.env.LZ_FIXTURES) : join(ROOT, 'fixtures');
const FIX = join(FIXTURES, 'real');
/** --face=<model>: a candidate face model from fixtures/models instead of the shipped one; results go to .rubric/realcheck/<model>/. */
const MODEL = process.argv.find((a) => a.startsWith('--face='))?.slice(7) ?? '';
const OUT = join(process.env.LZ_REALCHECK_OUT ? resolve(process.env.LZ_REALCHECK_OUT) : join(ROOT, '.rubric', 'realcheck'), MODEL);
const PORT = Number(process.env.LZ_REALCHECK_PORT || 5198);
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

async function openProbe(): Promise<{ page: Page; version: string }> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  // Fixtures stay out of public/: serve them to the page from disk.
  await page.route('**/__fixtures/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__fixtures\//, ''));
    const base = rel.startsWith('models/') ? FIXTURES : FIX;
    const file = join(base, rel);
    if (!file.startsWith(base) || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.png') ? 'image/png' : file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.json') ? 'application/json' : file.endsWith('.bin') ? 'application/octet-stream' : 'image/jpeg' });
  });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${PORT}/?realcheck${MODEL ? `&face=${MODEL}` : ''}`);
  await page.waitForFunction(() => '__lzReal' in window, null, { timeout: 60_000 });
  const version = await page.evaluate(() => (window as unknown as { __lzReal: { ready(): Promise<string> } }).__lzReal.ready());
  console.log('models ready, Human', version);
  return { page, version };
}

/**
 * A clip's frames at `fps`, each probed as a camera frame. ffmpeg extracts them once into
 * fixtures/real/frames/<clip>/ (decoding video inside headless Chrome ran out of media players).
 */
async function probeVideo(page: Page, src: string, fps: number): Promise<(ProbeImage & { t: number })[]> {
  const clip = src.split('/').pop()!.replace(/\.mp4$/, '');
  const dir = join(FIX, 'frames', `${clip}@${fps}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-i', join(FIX, 'clips', `${clip}.mp4`), '-vf', `fps=${fps}`, '-q:v', '2', join(dir, '%04d.jpg')], { stdio: 'pipe' });
    } catch {
      rmSync(dir, { recursive: true, force: true });
      console.log(`${clip}: could not extract frames, skipped`);
      return [];
    }
  }
  const out: (ProbeImage & { t: number })[] = [];
  for (const [i, f] of readdirSync(dir).filter((x) => x.endsWith('.jpg')).sort().entries()) {
    const r = await page.evaluate((s) => (window as unknown as { __lzReal: { probeFrame(s: string): Promise<ProbeImage> } }).__lzReal.probeFrame(s), `/__fixtures/frames/${clip}@${fps}/${f}`);
    out.push({ ...r, t: i / fps });
  }
  return out;
}

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
 * Zoom crop cost over every face probed: the median (a candidate model loads without warmup, so a
 * page's first crops include shader compilation) and the 90th percentile, in ms.
 */
const cropCost = (ms: number[]) => ({ msPerCrop: Math.round(10 * pct(ms, 50)) / 10, msPerCropP90: Math.round(10 * pct(ms, 90)) / 10, crops: ms.length });

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
  const cropMs: number[] = [];
  let ms = 0;
  let n = 0;
  for (const person of people) {
    const photos: Face[][] = [];
    for (const file of readdirSync(join(dir, person)).filter((f) => f.endsWith('.jpg')).sort()) {
      const r = await probe(page, `/__fixtures/stills/${person}/${file}`);
      raw[`${person}/${file}`] = r;
      cropMs.push(...r.faces.map((f) => f.cropMs));
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
    ...cropCost(cropMs),
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
  console.log(`\nfaces: ${n} photos of ${people.length} people, ${Math.round(ms / Math.max(1, n))} ms each, zoom crop ${summary.msPerCrop} ms (p90 ${summary.msPerCropP90}, ${summary.crops} crops); ${own.length} own faces, ${strangers.length} strangers`);
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
  // Stubs under 20 KB are downloads that failed or are still in progress.
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('talker-') && f.endsWith('.mp4') && statSync(join(dir, f)).size > 20_000).sort() : [];
  if (names.length < 1) {
    console.log('clips: no talker clips in fixtures/real/clips');
    return null;
  }
  const people: { name: string; profile: number[][]; live: { t: number; px: number; yaw: number; e: number[] }[] }[] = [];
  const cropMs: number[] = [];
  for (const file of names) {
    const frames = await probeVideo(page, `/__fixtures/clips/${file}`, 5);
    for (const f of frames) cropMs.push(...f.faces.map((x) => x.cropMs));
    // Follow each face by position (people in an interview stay put): one identity per seat.
    type Seat = { cx: number; cy: number; faces: { t: number; face: ProbeImage['faces'][number] }[] };
    const seats: Seat[] = [];
    for (const f of frames) {
      for (const face of f.faces.filter((x) => x.embedding.length && x.px >= MIN_FACE_PX && x.yaw <= MAX_YAW_DEG)) {
        const cx = face.box[0] + face.box[2] / 2;
        const cy = face.box[1] + face.box[3] / 2;
        let seat = seats.find((s) => Math.hypot(s.cx - cx, s.cy - cy) < Math.max(0.08, face.box[3]));
        if (!seat) seats.push((seat = { cx, cy, faces: [] }));
        seat.cx = 0.8 * seat.cx + 0.2 * cx;
        seat.cy = 0.8 * seat.cy + 0.2 * cy;
        seat.faces.push({ t: f.t, face });
      }
    }
    seats.filter((s) => s.faces.length >= 30).forEach((seat, k) => {
      const enrol = seat.faces.filter((x) => x.t < ENROL_S);
      // Spread the eight samples over the enrolment window.
      const step = Math.max(1, Math.floor(enrol.length / 8));
      const profile = enrol.filter((_, i) => i % step === 0).slice(0, 8).map((x) => x.face.embedding);
      const live = seat.faces.filter((x) => x.t >= ENROL_S + 1).map((x) => ({ t: x.t, px: Math.round(x.face.px), yaw: Math.round(x.face.yaw), e: x.face.embedding }));
      if (profile.length < 3 || live.length < 10) return;
      people.push({ name: `${file.replace(/\.mp4$/, '')}#${k}`, profile, live });
      console.log(`${file} seat ${k}: ${seat.faces.length} faces, profile ${profile.length}, live ${live.length}`);
    });
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
    ...cropCost(cropMs),
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
  console.log(`zoom crop     ${summary.msPerCrop} ms median, p90 ${summary.msPerCropP90} ms (${summary.crops} crops)`);
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
  /** Every run with the photo it shot at: the units the bounds below count. */
  const runs: ShootRun[] = [];
  const total = { shots: 0, correct: 0, wrong: 0, unclear: 0, miss: 0, offTarget: 0, wrongLockFrames: 0 };
  const missCauses: Record<string, number> = {};
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
      const causes = await page.evaluate(() => (window as unknown as { __bench: { raw(): { shots: { outcome: string; cause?: string }[] } } }).__bench.raw().shots.filter((x) => x.outcome === 'miss').map((x) => x.cause ?? 'unknown'));
      for (const c of causes) missCauses[c] = (missCauses[c] ?? 0) + 1;
      rows.push({ photo, target, people, ...stats, missCauses: causes });
      runs.push({ photo, shots: stats.shots ?? 0, correct: stats.correct ?? 0, wrong: stats.wrong ?? 0 });
      if (stats.wrong > 0 || stats.wrongLockFrames > 0) {
        // Keep everything needed to explain it: who was enrolled where, every shot, the frame trace.
        const dump = await page.evaluate(() => {
          const b = (window as unknown as { __bench: { people(): unknown[]; raw(): { shots: unknown[]; trace: unknown[] } } }).__bench;
          return { people: b.people().map((p) => { const { profile: _p, ...rest } = p as { profile: unknown }; return rest; }), shots: b.raw().shots, trace: b.raw().trace };
        });
        const file = join(OUT, `shoot-fail-${photo.replace(/[/.]/g, '_')}-t${target}-${Date.now()}.json`);
        writeFileSync(file, JSON.stringify({ photo, target, ...dump }, null, 1));
        console.log('  saved', file);
      }
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += stats[k] ?? 0;
      console.log(`${photo} target ${target}: ${people} people, shots ${stats.shots} correct ${stats.correct} wrong ${stats.wrong} unclear ${stats.unclear} miss ${stats.miss} off ${stats.offTarget} wrongLock ${stats.wrongLockFrames} period ${stats.periodMs} ms`);
    }
  }
  console.log(`\nshoot: ${rows.length} runs, ${total.shots} shots: correct ${total.correct}, wrong ${total.wrong}, unclear ${total.unclear}, miss ${total.miss}, off-target ${total.offTarget}, wrong-lock frames ${total.wrongLockFrames}`);
  // What a clean run proves: exact one-sided 95% upper bounds on the wrong-hit rate, counted over
  // photos first, since the shots of a photo are not independent trials (src/feedback/stats.ts shootBounds).
  const bounds = shootBounds(runs);
  for (const line of formatShootBounds(bounds)) console.log(line);
  console.log('miss causes:', JSON.stringify(missCauses));
  writeFileSync(join(OUT, 'shoot.json'), JSON.stringify({ total, bounds, missCauses, rows }, null, 1));
  return { ...total, bounds };
}

// ---- scan ----------------------------------------------------------------------------------------

/**
 * The enrolment face scan against real head movement: every frame's signed yaw and pitch as the
 * game's crop mesh reads them, then the eight prompts in order the way a player would do them (the
 * conventions latched by earlier prompts carry over, a prompt needs SCAN_CALIB.holdFrames frames in
 * a row, and each sample must chain as the same person). Says which prompts each clip can satisfy
 * and the yaw/pitch range the model actually reports.
 */
async function scan(page: Page) {
  const dir = join(FIX, 'clips');
  const names = readdirSync(dir).filter((f) => (f.startsWith('talker-') || f === 'headturn.mp4') && statSync(join(dir, f)).size > 20_000).sort();
  const rows: Record<string, unknown>[] = [];
  for (const file of names) {
    const frames = await probeVideo(page, `/__fixtures/clips/${file}`, 10);
    const series = frames
      .map((f) => ({ t: f.t, face: [...f.faces].filter((x) => Number.isFinite(x.yawSigned) && x.px >= 48).sort((a, b) => b.px - a.px)[0] }))
      .filter((x) => x.face);
    // A clip cannot follow prompts, so ask of each prompt independently: is there a run of
    // holdFrames frames that satisfies it, with left/right and chin up/down latched as a player's
    // first turn and first tilt would latch them?
    const firstTurn = series.find((x) => Math.abs(x.face.yawSigned) >= FACE_PROMPTS[1].yaw![0]);
    const firstTilt = series.find((x) => Math.abs(x.face.pitch) >= 8);
    const latched: ScanState = { ...initialScanState(), yawSign: firstTurn ? Math.sign(firstTurn.face.yawSigned) : 0, pitchSign: firstTilt ? Math.sign(firstTilt.face.pitch) : 0 };
    const done: string[] = [];
    const missing: string[] = [];
    for (const prompt of FACE_PROMPTS) {
      let state = latched;
      let at: number | null = null;
      for (const x of series) {
        const step = holdStep(state, judgePose(prompt, x.face.yawSigned, Number.isFinite(x.face.pitch) ? x.face.pitch : 0, state));
        state = { ...step.state, yawSign: latched.yawSign, pitchSign: latched.pitchSign };
        if (step.ready) {
          at = x.t;
          break;
        }
      }
      (at === null ? missing : done).push(at === null ? prompt.text : `${prompt.text} @${at.toFixed(1)}s`);
    }
    const yaws = series.map((x) => x.face.yawSigned);
    const pitches = series.map((x) => x.face.pitch).filter(Number.isFinite);
    const row = { clip: file, faceFrames: series.length, frames: frames.length, yaw: [Math.round(Math.min(...yaws)), Math.round(Math.max(...yaws))], pitch: [Math.round(Math.min(...pitches)), Math.round(Math.max(...pitches))], prompts: `${done.length}/${FACE_PROMPTS.length}`, done, missing };
    rows.push(row);
    console.log(`${file}: ${series.length}/${frames.length} frames with a face, yaw ${row.yaw.join('..')}°, pitch ${row.pitch.join('..')}°, prompts ${row.prompts}`);
    for (const m of missing) console.log('    not reached:', m);
  }
  // The face stage itself (scan.ts faceStageStep, what Scanner.tsx runs) over each clip as a camera,
  // tapping Skip this angle whenever it is offered; and over a splice of two people.
  const toObs = (f: ProbeImage & { t: number }, offset = 0): FaceObs => {
    const face = f.faces.length === 1 ? f.faces[0] : null;
    const blocked = f.faces.length === 0 ? 'No face found.' : f.faces.length > 1 ? 'Only one face in frame please.' : face!.score < 0.7 ? 'Move into better light and face the camera.' : face!.px < 48 ? 'Move closer so your face is clear.' : '';
    return { t: (f.t + offset) * 1000, faces: f.faces.length, box: face ? face.box : null, blocked, yaw: face && Number.isFinite(face.yawSigned) ? face.yawSigned : 0, pitch: face && Number.isFinite(face.pitch) ? face.pitch : 0, embedding: face && Number.isFinite(face.yawSigned) ? face.embedding : [] };
  };
  const replay = (obs: FaceObs[]) => {
    let st = initialFaceStage(obs[0]?.t ?? 0);
    let doneAt: number | null = null;
    let skips = 0;
    let patience = 0;
    for (const o of obs) {
      let r = faceStageStep(st, o);
      if (!r.accepted && r.skippable) {
        const k = skipFaceAngle(r.stage, o.t);
        if (k) {
          r = k;
          skips++;
        }
      }
      if (r.accepted && r.stage.samples.at(-1)!.embedding !== o.embedding) patience++;
      st = r.stage;
      if (st.samples.length >= FACE_SAMPLES) {
        doneAt = o.t;
        break;
      }
    }
    return { samples: st.samples.length, doneS: doneAt === null ? null : Math.round((doneAt - obs[0].t) / 100) / 10, skips, patience };
  };
  const stageRows: Record<string, unknown>[] = [];
  const byClip = new Map<string, (ProbeImage & { t: number })[]>();
  for (const file of names.filter((f) => f.startsWith('talker-'))) {
    const frames = await probeVideo(page, `/__fixtures/clips/${file}`, 10);
    byClip.set(file, frames);
    // A clip played twice in a row, as Chrome loops a camera file.
    const obs = [...frames.map((f) => toObs(f)), ...frames.map((f) => toObs(f, frames.length / 10))];
    const r = replay(obs);
    stageRows.push({ clip: file, ...r });
    console.log(`face stage ${file}: ${r.samples}/8 samples${r.doneS !== null ? ` in ${r.doneS} s` : ''}, ${r.patience} by patience, ${r.skips} skipped`);
  }
  writeFileSync(join(OUT, 'scan.json'), JSON.stringify({ prompts: rows, faceStage: stageRows }, null, 1));
  return rows;
}

async function main() {
  if (!existsSync(FIX)) throw new Error('no fixtures: run python3 scripts/fetch-fixtures.py first');
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const { page, version } = await openProbe();
  const result: Record<string, unknown> = { at: new Date().toISOString(), models: version };
  try {
    if (want('faces')) result.faces = await faces(page);
    if (want('clips')) result.clips = await clips(page);
    if (want('shoot')) result.shoot = await shoot(page);
    if (want('scan')) result.scan = await scan(page);
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
