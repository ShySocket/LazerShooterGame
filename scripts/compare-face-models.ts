/**
 * Compare face embedding models on the realcheck fixtures, fairly: every model is centred on its own
 * mean face (FACE_MEAN only fits the shipped model) and scored against the same identity labels
 * (taken from the shipped model's labelling, matched to each model's faces by photo and box).
 *
 *     npm run realcheck -- faces clips [--face=<model>]   (once per model)
 *     node --import ./tests/register.mjs scripts/compare-face-models.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '..', '.rubric', 'realcheck');
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
  let clip = '';
  if (existsSync(join(dir, 'clips.json'))) {
    const cl = JSON.parse(readFileSync(join(dir, 'clips.json'), 'utf8')) as { people: { profile: number[][]; live: { e: number[] }[] }[] };
    const own: number[] = [];
    const meanOwn: number[] = [];
    const str: number[] = [];
    for (const p of cl.people) {
      const prof = p.profile.map(c);
      const best = (v: number[]) => Math.max(...prof.map((q) => dot(v, q)));
      let tm: number[] | null = null;
      let n = 0;
      for (const l of p.live) {
        own.push(best(c(l.e)));
        const a = Math.max(0.3, 1 / (n + 1));
        tm = tm ? unit(tm.map((x, i) => (1 - a) * x + a * l.e[i])) : unit(l.e);
        if (++n >= 3) meanOwn.push(best(c(tm)));
      }
      for (const f of faces) str.push(best(c(f.embedding)));
    }
    // Co-present people: each person's live frames against every other clip person's scan (same light, same room).
    const other: number[] = [];
    const margins: number[] = [];
    for (const p of cl.people) {
      const ownProf = p.profile.map(c);
      for (const l of p.live) {
        const v = c(l.e);
        const mine = Math.max(...ownProf.map((q) => dot(v, q)));
        let rival = -1;
        for (const q of cl.people) if (q !== p) rival = Math.max(rival, ...q.profile.map((x) => dot(v, c(x))));
        other.push(rival);
        margins.push(mine - rival);
      }
    }
    const s99 = pct(str, 99);
    const smax = pct(str, 100);
    clip = `clip frame p5 ${pct(own, 5).toFixed(2)} p50 ${pct(own, 50).toFixed(2)} | track mean p5 ${pct(meanOwn, 5).toFixed(2)} | strangers p99 ${s99.toFixed(2)} max ${smax.toFixed(2)} | mean-frames above stranger max ${Math.round((100 * meanOwn.filter((x) => x > smax).length) / meanOwn.length)}% | other person max ${pct(other, 100).toFixed(2)} | own-minus-rival p5 ${pct(margins, 5).toFixed(2)} (${Math.round((100 * margins.filter((x) => x <= 0).length) / margins.length)}% ≤ 0)`;
  }
  return { items: items.length, gen: gen.length, imp: imp.length, eer: eer.e, eerT: eer.t, tar1, clip };
}

const dirs = [['shipped model', OUT], ...readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => [d.name, join(OUT, d.name)])];
for (const [name, dir] of dirs) {
  if (!existsSync(join(dir, 'embeddings.json'))) continue;
  const r = evaluate(dir);
  if (!r) {
    console.log(`${name.padEnd(40)} no usable embeddings`);
    continue;
  }
  console.log(`${name.padEnd(40)} faces ${r.items}  EER ${(100 * r.eer).toFixed(1)}% @${r.eerT.toFixed(2)}  TAR@FAR1% ${(100 * r.tar1).toFixed(0)}%  (${r.gen} same / ${r.imp} different pairs)`);
  if (r.clip) console.log(`${''.padEnd(40)} ${r.clip}`);
}
