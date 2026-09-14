import test from 'node:test';
import assert from 'node:assert/strict';
import { shotLog } from '../src/debug/shotLog';
import { CALIBRATION_VERSION, FACE_CALIB, GEOMETRY_FRESH_MS, HEIGHT_MATCH_MIN } from '../src/vision/calibration';
import { FACE_CALIB as fromEmbedding } from '../src/vision/embedding';
import { GEOMETRY_FRESH_MS as fromShot } from '../src/vision/shot';
import { HEIGHT_MATCH_MIN as fromTracker } from '../src/vision/tracker';

test('every shot log entry records the calibration version that decided it', () => {
  shotLog.clear();
  shotLog.add({ t: 1, outcome: 'hit', beliefs: [] });
  shotLog.add({ t: 2, outcome: 'miss', beliefs: [], calibration: 'older' });
  const [a, b] = shotLog.all();
  assert.equal(a.calibration, CALIBRATION_VERSION);
  assert.equal(b.calibration, 'older', 'an explicit version (a replayed record) is kept');
  assert.match(CALIBRATION_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  shotLog.clear();
});

test('the modules re-export the calibration values unchanged', () => {
  assert.equal(fromEmbedding, FACE_CALIB);
  assert.equal(fromShot, GEOMETRY_FRESH_MS);
  assert.equal(fromTracker, HEIGHT_MATCH_MIN);
});
