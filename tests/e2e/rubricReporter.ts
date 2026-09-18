import { mkdirSync, writeFileSync } from 'node:fs';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Writes .rubric/e2e.json: one entry per test whose title starts with `[name]`, the name being the
 * rubric's `e2e:<name>` evidence tag (docs/tracking-rubric.md). A name that appears in several tests
 * passes only when all of them pass.
 */
export default class RubricReporter implements Reporter {
  private tests: Record<string, { status: 'pass' | 'fail'; durationMs: number; note?: string }> = {};

  onTestEnd(test: TestCase, result: TestResult): void {
    const m = test.title.match(/^\[([\w-]+)\]/);
    if (!m) return;
    const ok = result.status === 'passed';
    const prev = this.tests[m[1]];
    const note = ok ? prev?.note : (result.error?.message ?? result.status).split('\n')[0].slice(0, 160);
    this.tests[m[1]] = { status: ok && (!prev || prev.status === 'pass') ? 'pass' : 'fail', durationMs: Math.round(result.duration + (prev?.durationMs ?? 0)), ...(note ? { note } : {}) };
  }

  onEnd(): void {
    mkdirSync('.rubric', { recursive: true });
    writeFileSync('.rubric/e2e.json', JSON.stringify({ date: new Date().toISOString(), tests: this.tests }, null, 2));
  }
}
