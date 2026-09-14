import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Room } from '../types';
import { ShotReview } from './ShotReview';
import { feedbackStore } from './store';
import { IdMap, roundKey, SAMPLE_VERSION, type ShotSample } from './sample';
import { renderShotPhoto } from './photo';

/**
 * Dev-only stand-in for a finished round (?review): seeds the feedback store with a synthetic shot
 * and photo, then renders the real review card against a fake room, so the card can be checked in
 * a browser without a camera or other phones. Run it with `npm run dev:local`, which keeps uploads
 * in memory (window.__lz.backend.feedback).
 */
const PLAYERS = [
  { id: 'demo-me', name: 'You', color: '#3bd1ff' },
  { id: 'demo-ana', name: 'Ana', color: '#ff3b5c' },
  { id: 'demo-ben', name: 'Ben', color: '#ffd23b' },
];
const CODE = 'DEMO';
/** A round that ended a moment ago; the store forgets rounds older than a few hours. */
const START = Date.now() - 90_000;

function fakeRoom(): Room {
  const players = Object.fromEntries(
    PLAYERS.map((p) => [p.id, { ...p, joinedAt: START, connected: true, enrolled: true, lives: 3, status: 'alive' as const, lastHitAt: 0, eliminatedAt: null, tags: 0 }]),
  );
  return { code: CODE, hostId: 'demo-me', createdAt: START, status: 'ended', startAt: START, endedAt: START + 90_000, winnerId: 'demo-ana', settings: DEFAULT_SETTINGS, players, profiles: {} };
}

/** A dim room with two people-shaped silhouettes, one of them under the dot. */
function fakeFrame(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, '#2b3350');
  g.addColorStop(1, '#0b0f1a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const person = (x: number, w: number, top: string, legs: string) => {
    ctx.fillStyle = '#d9b99b';
    ctx.beginPath();
    ctx.arc(x, 110, w * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = top;
    ctx.fillRect(x - w / 2, 135, w, 110);
    ctx.fillStyle = legs;
    ctx.fillRect(x - w / 2 + 4, 245, w / 2 - 6, 110);
    ctx.fillRect(x + 2, 245, w / 2 - 6, 110);
  };
  person(330, 70, '#ff3b5c', '#223');
  person(520, 46, '#ffd23b', '#556');
  return c;
}

function fakeSample(ids: IdMap): ShotSample {
  return {
    v: SAMPLE_VERSION,
    app: { commit: 'demo', faceModel: 'demo', bodyModel: 'demo', ua: navigator.userAgent.slice(0, 80) },
    round: { key: roundKey(CODE, START), code: CODE, startAt: START, settings: DEFAULT_SETTINGS, players: 3, shooter: ids.pid('demo-me'), eligible: [ids.pid('demo-ana'), ids.pid('demo-ben')] },
    device: { periodMs: 210, staleMs: 543, burstMs: 525, width: 1280, height: 720 },
    shot: {
      id: 'demo-shot',
      roundMs: 47_300,
      outcome: 'unclear',
      kind: 'pending',
      resolvedTo: null,
      via: null,
      resolveMs: 412,
      zoom: true,
      frameAgeMs: 180,
      allowanceMs: 543,
      crosshair: [0.29, 0.35, 0.42, 0.3],
      trackId: 3,
      decidedAtFrame: 1,
      settledBy: 'frame',
      decisionTrackId: 3,
      decisionBelief: { [ids.pid('demo-ana')]: 0.41, unknown: 0.3 },
    },
    frames: [
      { t: -220, tracks: [{ id: 3, box: [0.4, 0.2, 0.2, 0.7], hit: [0.44, 0.22, 0.12, 0.35], belief: { [ids.pid('demo-ana')]: 0.38, unknown: 0.32 }, via: 'clothing', conflict: false, ambiguous: false, faceSamples: 0, faceAgeMs: null, evidenceAgeMs: 0, inSight: true, outfit: { match: { [ids.pid('demo-ana')]: { sim: 0.7, cov: 0.8, thighs: true }, [ids.pid('demo-ben')]: { sim: 0.3, cov: 0.8, thighs: true } } } }], lock: null },
      { t: 200, tracks: [{ id: 3, box: [0.4, 0.2, 0.2, 0.7], hit: [0.44, 0.22, 0.12, 0.35], belief: { [ids.pid('demo-ana')]: 0.41, unknown: 0.3 }, via: 'clothing', conflict: false, ambiguous: false, faceSamples: 0, faceAgeMs: null, evidenceAgeMs: 0, inSight: true }], lock: `maybe:${ids.pid('demo-ana')}` },
    ],
    target: { trackId: 3, faceMean: null, faceSamples: 0, outfit: { top: [1] }, props: null, liveFaces: {} },
  };
}

export function ReviewDemo() {
  const [ready, setReady] = useState(false);
  const room = fakeRoom();
  useEffect(() => {
    const ids = new IdMap(PLAYERS.map((p) => p.id));
    const key = roundKey(CODE, START);
    (async () => {
      await feedbackStore.beginRound({ key, code: CODE, startAt: START, ids: ids.all(), profiles: {} });
      const photo = await renderShotPhoto(fakeFrame(), [0.29, 0.35, 0.42, 0.3]);
      const sample = fakeSample(ids);
      await feedbackStore.saveShot({ id: 'demo-shot', round: key, outcome: 'unclear', hadTrack: true, roundMs: sample.shot.roundMs, sample, photo });
      await feedbackStore.saveShot({ id: 'demo-shot-2', round: key, outcome: 'miss', hadTrack: false, roundMs: 61_000, sample: { ...sample, shot: { ...sample.shot, id: 'demo-shot-2', outcome: 'miss', trackId: null } }, photo });
      setReady(true);
    })();
  }, []);
  return (
    <div className="screen center">
      <div className="label">Review card demo</div>
      <h1 className="title">Ana wins</h1>
      {ready ? <ShotReview room={room} pid="demo-me" /> : <p className="sub">Seeding a synthetic shot</p>}
      <button className="link" onClick={() => location.reload()}>
        Reload to seed again
      </button>
    </div>
  );
}
