import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuota } from '../src/quota.ts';

const snapshot = (remaining: unknown = '100') => ({
  url: 'https://chat.qwen.ai/settings/usage-billing',
  phase: 'ready',
  weekly: { remaining },
  resetText: 'Сброс через 7 дн. 0 ч.',
});

test('100 percent remaining means zero consumed, without inventing a reset date', () => {
  assert.deepEqual(parseQuota(snapshot()), {
    remainingPercent: 100, usedPercent: 0, resetText: 'Сброс через 7 дн. 0 ч.',
  });
});

test('partial and exhausted remaining quotas become consumed percentages', () => {
  assert.equal(parseQuota(snapshot('73.25')).usedPercent, 26.75);
  assert.equal(parseQuota(snapshot('0')).usedPercent, 100);
});

test('empty, nonnumeric and out-of-range values are unavailable', () => {
  for (const v of ['', null, undefined, 'NaN', 'Infinity', '-1', '100.1', '50%', 73]) {
    assert.throws(() => parseQuota({ ...snapshot(), weekly: { remaining: v } }), /invalid_quota/);
  }
});

test('sign-in, loading and error pages cannot produce a quota', () => {
  for (const phase of ['sign-in', 'loading', 'error']) {
    assert.throws(() => parseQuota({ ...snapshot(), phase }), /not_ready/);
  }
});

test('only the exact Qwen usage page is accepted', () => {
  for (const url of ['https://example.com/settings/usage-billing', 'https://chat.qwen.ai/',
    'http://chat.qwen.ai/settings/usage-billing', 'https://chat.qwen.ai.evil.test/settings/usage-billing']) {
    assert.throws(() => parseQuota({ ...snapshot(), url }), /unexpected_page/);
  }
});
