import type { BodyResult, FaceResult } from '@vladmandic/human';
import { iou, type NBox } from './geometry';

export interface Detection {
  box: NBox;
  body?: BodyResult;
  face?: FaceResult;
}

export interface Track {
  id: number;
  box: NBox;
  lastSeen: number;
  /** Per-player identity belief in 0..1, updated by face and clothing evidence. */
  belief: Record<string, number>;
  /** Belief with identities claimed by stronger tracks removed. Refreshed every frame by assignIdentities. */
  claimed: Record<string, number> | null;
  via: 'face' | 'clothing' | 'none';
  lastFaceAt: number;
  /** Running mean of the unit face embeddings seen on this track, so matching uses many frames rather than one. */
  faceMean: number[] | null;
  faceSamples: number;
}

/** Keeps identities attached to bodies across frames using box overlap. */
export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;

  update(dets: Detection[], now: number, ttlMs = 1500): Track[] {
    const assigned: (Track | null)[] = dets.map(() => null);
    const used = new Set<Track>();
    const pairs: { d: number; t: Track; v: number }[] = [];
    dets.forEach((d, di) => {
      for (const t of this.tracks) {
        const v = iou(d.box, t.box);
        if (v > 0.2) pairs.push({ d: di, t, v });
      }
    });
    pairs.sort((a, b) => b.v - a.v);
    for (const p of pairs) {
      if (assigned[p.d] || used.has(p.t)) continue;
      assigned[p.d] = p.t;
      used.add(p.t);
    }
    const out = dets.map((d, i) => {
      let t = assigned[i];
      if (!t) {
        t = { id: this.nextId++, box: d.box, lastSeen: now, belief: {}, claimed: null, via: 'none', lastFaceAt: 0, faceMean: null, faceSamples: 0 };
        this.tracks.push(t);
      }
      t.box = d.box;
      t.lastSeen = now;
      return t;
    });
    this.tracks = this.tracks.filter((t) => now - t.lastSeen < ttlMs);
    return out;
  }

  /** Every track still within its time-to-live, including ones not matched this frame. */
  live(): Track[] {
    return this.tracks;
  }

  get(id: number): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  reset(): void {
    this.tracks = [];
  }
}
