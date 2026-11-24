import test from 'node:test';
import assert from 'node:assert/strict';
import { measurement } from '../src/measurement.ts';

test('panel receives consumed percentage and no invented account or reset timestamp', () => {
  const result = measurement({ status: 'ok', observedAt: 123,
    quota: { remainingPercent: 75, usedPercent: 25, resetText: '7d 0h' } });
  assert.deepEqual(result, { accountKey: null, observedAt: 123, usage: {
    status: 'ok', accountEmail: null, planLabel: null, plan: null,
    windows: [{ id: 'weekly', label: 'Weekly limit', kind: 'weekly', usedPercent: 25,
      resetsAt: null, model: null, cost: null }],
  } });
});

test('collection failure produces an error without a stale window', () => {
  const result = measurement({ status: 'error', observedAt: 123, code: 'sign_in_required' });
  assert.equal(result.observedAt, 123);
  assert.equal(result.usage.status, 'error');
  assert.equal('windows' in result.usage, false);
  assert.match(JSON.stringify(result), /qwen-usage connect/);
});
