/**
 * Compare face embedding models on the realcheck fixtures, fairly: every model is centred on its own
 * mean face (FACE_MEAN only fits the shipped model) and scored against the same identity labels
 * (taken from the shipped model's labelling, matched to each model's faces by photo and box).
 *
 *     npm run realcheck -- faces clips [--face=<model>]   (once per model)
 *     node --import ./tests/register.mjs scripts/compare-face-models.ts
 *
 * Results are read from .rubric/realcheck/ (the shipped model) and its <model>/ subdirectories, or
 * from LZ_REALCHECK_OUT when set (the same variable scripts/realcheck.ts writes to).
 *
 * EER and TAR@FAR1% describe a model in general; the game runs at a far stricter point, where a wrong
 * hit must not happen at all. So each model is also judged at the operating point, on the clips
 * (same-session frames of enrolled talkers, which is what a round sees): the share of genuine frames
 * and running track means above a cutoff, for three cutoffs.
 *   - zero FA: the strictest cutoff that still accepts no impostor, i.e. just above the highest of
 *     (a) every still face (nobody in the photo set enrolled) against each talker's profile and
 *     (b) every other talker's profile (full roster): for genuine frames, the other talkers' frames;
 *     for genuine track means, the other talkers' track means. A single frame is what the first
 *     frames of a track and the overlap rule's own face read rely on; the track mean is what the
 *     belief is built from.
 *   - FACE_CALIB and FACE_ONLY: each calibration is a ramp (reject..accept), so it is expressed as the
 *     similarity at which a face alone, at full quality, gives a hit (scoring.ts faceEvidence then
 *     resolveHit: evidence at least hitThreshold and ahead of the stranger baseline by hitMargin).
 *     That cutoff is in the shipped model's scale; another model gets the equivalent cutoff that lets
 *     the same number of these impostor comparisons through (scaled by the set sizes) while the
 *     shipped cutoff lets any through, and otherwise the same headroom above its own worst impostor,
 *     measured in impostor standard deviations. A wrong hit lives in the tail, and the tails differ
 *     between models, so the match is made on false accepts rather than on the bulk (z-norm).
 * The 5 highest single-frame impostor scores are listed per model, each with the share of genuine
 * frames above it, to show how much the zero-FA cutoff rests on one face.
 * ms/crop is the median wall time of one face's zoom crop pass (crop + detector + mesh + embedding
 * model) in the headless Chrome realcheck uses, from the faces and the clips stage: relative cost
 * between models on this machine, not a phone's number.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FACE_CALIB, FACE_ONLY_CALIB, MEAN_ALPHA } from '../src/vision/calibration.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';

const OUT = process.env.LZ_REALCHECK_OUT ? resolve(process.env.LZ_REALCHECK_OUT) : resolve(import.meta.dirname, '..', '.rubric', 'realcheck');
type Box = [number, number, number, number];
interface Face { person: string; photo: string; box: Box; embedding: number[] }

const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const meanOf = (vs: number[][]) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))] : NaN;
};
const maxOf = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), -Infinity);
const iou = (a: Box, b: Box) => {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const i = x * y;
  return i / (a[2] * a[3] + b[2] * b[3] - i);
};
const src = (f: Face) => (f.photo.includes('/') ? f.photo : `${f.person}/${f.photo}`);

const ref = JSON.parse(readFileSync(join(OUT, 'embeddings.json'), 'utf8')) as { own: Face[]; strangers: Face[] };
const labelled = [...ref.own.map((f) => ({ f, id: f.person })), ...ref.strangers.map((f, i) => ({ f, id: `stranger-${i}` }))];
// --solo: only photos with exactly one usable face, where the folder names the person for certain.
const SOLO = process.argv.includes('--solo');
const faceCount = new Map<string, number>();
for (const l of labelled) faceCount.set(src(l.f), (faceCount.get(src(l.f)) ?? 0) + 1);

/** Every comparison on the clips that the operating point is judged on. */
interface ClipScores {
  people: string[];
  /** Genuine: each live frame against the talker's own profile (best of profile, as the game scores). */
  frames: number[];
  /** Genuine: the talker's running track mean (from the third frame) against their own profile. */
  means: number[];
  /** Impostor (a): every still face against each talker's profile. */
  stills: number[];
  /** Impostor (b): each live frame against every other talker's profile. */
  rosterFrames: number[];
  /** Impostor (b): each running track mean against every other talker's profile. */
  rosterMeans: number[];
  /** Per live frame: own score minus the best other talker's score. */
  margins: number[];
}

function clipScores(dir: string, faces: Face[], c: (v: number[]) => number[]): ClipScores | null {
  if (!existsSync(join(dir, 'clips.json'))) return null;
  const cl = JSON.parse(readFileSync(join(dir, 'clips.json'), 'utf8')) as { people: { name: string; profile: number[][]; live: { e: number[] }[] }[] };
  const people = cl.people.filter((p) => p.profile.length > 0 && p.live.length > 0);
  if (people.length === 0) return null;
  const profiles = people.map((p) => p.profile.map(c));
  const best = (v: number[], k: number) => maxOf(profiles[k].map((q) => dot(v, q)));
  const stillVecs = faces.map((f) => c(f.embedding));
  const s: ClipScores = { people: people.map((p) => p.name), frames: [], means: [], stills: [], rosterFrames: [], rosterMeans: [], margins: [] };
  people.forEach((p, k) => {
    // The game folds raw unit embeddings into the track mean (scoring.ts updateFaceMean) and centres it to compare.
    let tm: number[] | null = null;
    let n = 0;
    for (const l of p.live) {
      const v = c(l.e);
      const mine = best(v, k);
      s.frames.push(mine);
      let rival = -1;
      for (let j = 0; j < people.length; j++) {
        if (j === k) continue;
        const r = best(v, j);
        s.rosterFrames.push(r);
        rival = Math.max(rival, r);
      }
      if (people.length > 1) s.margins.push(mine - rival);
      const a = Math.max(MEAN_ALPHA, 1 / (n + 1));
      tm = tm ? unit(tm.map((x, i) => (1 - a) * x + a * l.e[i])) : unit(l.e);
      if (++n >= 3) {
        const m = c(tm);
        s.means.push(best(m, k));
        for (let j = 0; j < people.length; j++) if (j !== k) s.rosterMeans.push(best(m, j));
      }
    }
    for (const v of stillVecs) s.stills.push(best(v, k));
  });
  return s;
}

/** Median zoom crop time recorded by scripts/realcheck.ts in a stage summary, NaN for runs before it was recorded. */
function msPerCrop(dir: string, file: 'faces.json' | 'clips.json'): number {
  if (!existsSync(join(dir, file))) return NaN;
  const ms = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { summary?: { msPerCrop?: number } }).summary?.msPerCrop;
  return typeof ms === 'number' ? ms : NaN;
}

function evaluate(dir: string) {
  const e = JSON.parse(readFileSync(join(dir, 'embeddings.json'), 'utf8')) as { own: Face[]; strangers: Face[] };
  const faces = [...e.own, ...e.strangers];
  if (faces.length === 0) return null;
  const m = meanOf(faces.map((f) => unit(f.embedding)));
  const c = (v: number[]) => unit(unit(v).map((x, i) => x - m[i]));
  // Carry the reference labels over by photo and box.
  const items: { id: string; photo: string; v: number[] }[] = [];
  for (const f of faces) {
    const r = labelled.find((l) => src(l.f) === src(f) && iou(l.f.box, f.box) > 0.5);
    if (r && (!SOLO || (faceCount.get(src(f)) === 1 && !src(f).split('/').slice(0, -1).join('/').includes('/') && src(f).startsWith(r.id + '/')))) items.push({ id: r.id, photo: src(f), v: c(f.embedding) });
  }
  const gen: number[] = [];
  const imp: number[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].photo === items[j].photo) continue;
      const s = dot(items[i].v, items[j].v);
      if (items[i].id === items[j].id) gen.push(s);
      else imp.push(s);
    }
  let eer = { t: 0, e: 1 };
  for (let t = -0.2; t < 1; t += 0.005) {
    const fr = gen.filter((x) => x < t).length / gen.length;
    const fa = imp.filter((x) => x >= t).length / imp.length;
    if (Math.max(fr, fa) < eer.e) eer = { t, e: Math.max(fr, fa) };
  }
  const far1 = pct(imp, 99);
  const tar1 = gen.filter((x) => x >= far1).length / gen.length;
  // Clips: same-session frames and the running mean against the talker's own scan; every still face as a stranger.
  const cs = clipScores(dir, faces, c);
  let clip = '';
  if (cs) {
    const s99 = pct(cs.stills, 99);
    const smax = maxOf(cs.stills);
    const rivals: number[] = [];
    for (let i = 0; i < cs.frames.length && cs.people.length > 1; i++) rivals.push(cs.frames[i] - cs.margins[i]);
    clip = `clip frame p5 ${pct(cs.frames, 5).toFixed(2)} p50 ${pct(cs.frames, 50).toFixed(2)} | track mean p5 ${pct(cs.means, 5).toFixed(2)} | strangers p99 ${s99.toFixed(2)} max ${smax.toFixed(2)} | mean-frames above stranger max ${Math.round((100 * cs.means.filter((x) => x > smax).length) / cs.means.length)}%`;
    if (cs.people.length > 1) clip += ` | other person max ${maxOf(rivals).toFixed(2)} | own-minus-rival p5 ${pct(cs.margins, 5).toFixed(2)} (${Math.round((100 * cs.margins.filter((x) => x <= 0).length) / cs.margins.length)}% ≤ 0)`;
  }
  return { items: items.length, gen: gen.length, imp: imp.length, eer: eer.e, eerT: eer.t, tar1, clip, cs };
}

const dirs = [['shipped model', OUT], ...readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => [d.name, join(OUT, d.name)])];
const results: { name: string; dir: string; cs: ClipScores | null }[] = [];
for (const [name, dir] of dirs) {
  if (!existsSync(join(dir, 'embeddings.json'))) continue;
  const r = evaluate(dir);
  if (!r) {
    console.log(`${name.padEnd(40)} no usable embeddings`);
    results.push({ name, dir, cs: null });
    continue;
  }
  console.log(`${name.padEnd(40)} faces ${r.items}  EER ${(100 * r.eer).toFixed(1)}% @${r.eerT.toFixed(2)}  TAR@FAR1% ${(100 * r.tar1).toFixed(0)}%  (${r.gen} same / ${r.imp} different pairs)`);
  if (r.clip) console.log(`${''.padEnd(40)} ${r.clip}`);
  results.push({ name, dir, cs: r.cs });
}

// ---- the operating point ----------------------------------------------------------------------

/** Every impostor comparison, labelled for the tail listing. */
const impostors = (s: ClipScores) => [
  ...s.stills.map((x) => ({ x, kind: 'still' })),
  ...s.rosterFrames.map((x) => ({ x, kind: 'roster frame' })),
  ...s.rosterMeans.map((x) => ({ x, kind: 'roster mean' })),
];
/** Spread of single impostor comparisons (still faces and other talkers' frames). */
function impostorSd(s: ClipScores) {
  const xs = [...s.stills, ...s.rosterFrames];
  const mu = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / xs.length);
}
/**
 * The similarity at which a face alone gives a hit under `calib`: faceEvidence maps it linearly from
 * reject to accept, and resolveHit needs the evidence at hitThreshold or more and ahead of the
 * stranger baseline (1 - evidence) by hitMargin.
 */
const faceAloneHit = (calib: { reject: number; accept: number }) => {
  const e = Math.max(DEFAULT_SETTINGS.hitThreshold, (1 + DEFAULT_SETTINGS.hitMargin) / 2);
  return calib.reject + e * (calib.accept - calib.reject);
};
const shareAbove = (xs: number[], t: number) => (xs.length ? (100 * xs.filter((x) => x > t).length) / xs.length : NaN);
const p0 = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}%` : '-').padStart(5);
const ms1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-').padStart(5);

const refRow = results.find((r) => r.name === 'shipped model' && r.cs && r.cs.people.length > 1);
const refImp = refRow ? impostors(refRow.cs!).map((i) => i.x) : [];
const refMax = maxOf(refImp);
const refSd = refRow ? impostorSd(refRow.cs!) : NaN;
/** The cutoff in this model's scale equivalent to the shipped model's cutoff `t` (see the header). */
function equivalent(t: number, cs: ClipScores, isRef: boolean): number {
  if (isRef) return t;
  const imp = impostors(cs).map((i) => i.x).sort((a, b) => b - a);
  const k = refImp.filter((x) => x > t).length;
  if (k > 0) {
    const km = Math.round((k * imp.length) / refImp.length);
    return km >= imp.length ? imp[imp.length - 1] - 1e-9 : imp[km];
  }
  return imp[0] + ((t - refMax) * impostorSd(cs)) / refSd;
}

const CUTS = [
  ['FACE_CALIB', faceAloneHit(FACE_CALIB)],
  ['FACE_ONLY', faceAloneHit(FACE_ONLY_CALIB)],
] as const;
console.log(
  `\nAt the operating point: each talker's later frames and running track mean against every enrolled talker's profile; cutoffs are centred similarity in each model's own scale, accepted = above the cutoff.` +
    `\nzero FA = just above the highest impostor: (a) every still face, (b) the other talkers' frames (for frames) or track means (for track means).` +
    `\n${CUTS.map(([n, t]) => `${n} = ${t.toFixed(3)}`).join(', ')}: where a face alone gives a hit (hitThreshold ${DEFAULT_SETTINGS.hitThreshold}, hitMargin ${DEFAULT_SETTINGS.hitMargin}) in the shipped model; other models get the cutoff with the same false accepts, or beyond every impostor the same headroom in impostor SDs. FA = impostor comparisons (stills, roster frames and means) above the cutoff.`,
);
console.log(`${'model'.padEnd(32)} ms/crop faces clips | talkers frames means | zero FA frames: cutoff (a / b) accepted | track means: cutoff (a / b) accepted | ${CUTS.map(([n]) => `${n} cutoff frames means FA       `).join('| ')}`);
const tails: string[] = [];
for (const { name, dir, cs } of results) {
  const timing = `${ms1(msPerCrop(dir, 'faces.json'))} ${ms1(msPerCrop(dir, 'clips.json'))}`;
  if (!cs || cs.people.length < 2) {
    console.log(`${name.padEnd(32)}       ${timing} | ${cs ? `${cs.people.length} talker, no roster to judge` : 'no usable embeddings'}`);
    continue;
  }
  const a = maxOf(cs.stills);
  const zero = (b: number, genuine: number[]) => `${Math.max(a, b).toFixed(2).padStart(6)} (${a.toFixed(2)} / ${b.toFixed(2)}) ${p0(shareAbove(genuine, Math.max(a, b)))}`;
  const imp = impostors(cs);
  const at = (t: number) => {
    if (!refRow) return ' '.repeat(31);
    const cut = equivalent(t, cs, cs === refRow.cs);
    const fa = imp.filter((i) => i.x > cut).length;
    return `${cut.toFixed(2).padStart(6)} ${p0(shareAbove(cs.frames, cut))} ${p0(shareAbove(cs.means, cut))}  ${`${fa}/${imp.length}`.padEnd(9)}`;
  };
  const roster = refRow && cs.people.join() !== refRow.cs!.people.join() ? `  (talkers differ from the shipped model's run: ${cs.people.join(', ')})` : '';
  console.log(
    `${name.padEnd(32)}       ${timing} | ${String(cs.people.length).padStart(7)} ${String(cs.frames.length).padStart(6)} ${String(cs.means.length).padStart(5)} |` +
      `         ${zero(maxOf(cs.rosterFrames), cs.frames)} |      ${zero(maxOf(cs.rosterMeans), cs.means)} |` +
      ` ${CUTS.map(([, t]) => `${at(t).padStart(13)}`).join(' | ')}${roster}`,
  );
  // How much the frame cutoff rests on single faces: the share of genuine frames above each of the worst single-frame impostors.
  const worst = imp.filter((i) => i.kind !== 'roster mean').sort((p, q) => q.x - p.x).slice(0, 5);
  tails.push(`${name.padEnd(32)} ${worst.map((i) => `${i.x.toFixed(2)} ${i.kind} ${Math.round(shareAbove(cs.frames, i.x))}%`).join(', ')}`);
}
if (tails.length) console.log(`\nthe 5 highest single-frame impostor scores, each with the share of genuine frames above it (the first is the zero-FA frame cutoff):\n${tails.join('\n')}`);
