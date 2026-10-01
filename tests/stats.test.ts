import test from 'node:test';
import assert from 'node:assert/strict';
import { binomialCdf, clopperPearsonUpper, formatBound, percentile, wrongHitBounds } from '../src/feedback/stats';

const near = (actual: number | null, expected: number, tol = 1e-9) => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);
};

test('the binomial CDF matches hand-computed values and its edges', () => {
  near(binomialCdf(0, 3, 0.5), 0.125);
  near(binomialCdf(1, 3, 0.5), 0.5);
  near(binomialCdf(2, 4, 0.25), (81 + 108 + 54) / 256);
  assert.equal(binomialCdf(-1, 5, 0.3), 0);
  assert.equal(binomialCdf(5, 5, 0.3), 1);
  assert.equal(binomialCdf(2, 5, 0), 1);
  assert.equal(binomialCdf(2, 5, 1), 0);
  // Large n does not underflow: 5 of 10 000 at p = 0.0005 is a Poisson(5) CDF at 5, about 0.616.
  near(binomialCdf(5, 10_000, 0.0005), 0.6160, 1e-3);
});

test('Clopper-Pearson upper bounds match exact references (60-digit Decimal bisection)', () => {
  // 0 wrong in 216 shots: the rate is below 1.38% at 95% (the "rule of three" says about 3/216).
  near(clopperPearsonUpper(0, 216), 0.013773397590468141, 1e-12);
  near(clopperPearsonUpper(1, 216), 0.02177291766737045, 1e-9);
  // Textbook values: 1 of 10 and 5 of 10 (the upper ends of the two-sided 90% intervals).
  near(clopperPearsonUpper(1, 10), 0.39416330243650477, 1e-9);
  near(clopperPearsonUpper(5, 10), 0.7775588989918709, 1e-9);
  near(clopperPearsonUpper(3, 100), 0.07571079374983006, 1e-9);
  near(clopperPearsonUpper(2, 50), 0.12061415542204414, 1e-9);
  near(clopperPearsonUpper(10, 1000), 0.016903175120562504, 1e-9);
  // Closed forms: k = 0 gives 1 - alpha^(1/n), k = n - 1 gives (1 - alpha)^(1/n).
  near(clopperPearsonUpper(0, 1), 0.95, 1e-12);
  near(clopperPearsonUpper(9, 10), Math.pow(0.95, 1 / 10), 1e-9);
  near(clopperPearsonUpper(0, 50, 0.99), 1 - Math.pow(0.01, 1 / 50), 1e-12);
});

test('Clopper-Pearson says nothing without trials, rises with k, falls with n, and rejects nonsense', () => {
  assert.equal(clopperPearsonUpper(0, 0), 1);
  assert.equal(clopperPearsonUpper(7, 7), 1);
  let last = 0;
  for (let k = 0; k < 20; k++) {
    const u = clopperPearsonUpper(k, 20);
    assert.ok(u > last && u > k / 20, `k=${k}: ${u}`);
    last = u;
  }
  assert.ok(clopperPearsonUpper(0, 400) < clopperPearsonUpper(0, 200));
  assert.ok(clopperPearsonUpper(2, 50, 0.99) > clopperPearsonUpper(2, 50, 0.95));
  assert.throws(() => clopperPearsonUpper(3, 2));
  assert.throws(() => clopperPearsonUpper(-1, 2));
  assert.throws(() => clopperPearsonUpper(1.5, 2));
  assert.throws(() => clopperPearsonUpper(1, 2, 1));
});

test('wrong-hit bounds are per attempt and per accepted hit, null with nothing to divide by', () => {
  const b = wrongHitBounds(0, 216, 120);
  near(b.perAttempt, 0.013773397590468141, 1e-12);
  near(b.perHit, 1 - Math.pow(0.05, 1 / 120), 1e-12);
  assert.deepEqual(wrongHitBounds(0, 0, 0), { perAttempt: null, perHit: null });
  assert.equal(wrongHitBounds(0, 12, 0).perHit, null);
  assert.equal(formatBound(0.013773397590468141), '≤1.38%');
  assert.equal(formatBound(0.39416), '≤39.4%');
  assert.equal(formatBound(null), '-');
});

test('percentiles interpolate between closest ranks and ignore non-finite values', () => {
  const xs = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
  assert.equal(percentile(xs, 50), 5.5);
  near(percentile(xs, 95), 9.55);
  assert.equal(percentile(xs, 0), 1);
  assert.equal(percentile(xs, 100), 10);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([1, 3], 50), 2);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([NaN, Infinity, 4], 50), 4);
  // The input is not reordered.
  assert.deepEqual(xs, [10, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
});
