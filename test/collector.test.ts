import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/collector.ts';
import { QuotaError } from '../src/quota.ts';

const quota = (remainingPercent: number) => ({ remainingPercent, usedPercent: 100 - remainingPercent, resetText: null });

test('cache lasts 60 seconds, while explicit refresh returns a fresh quota', async () => {
  let now = 100, remaining = 75;
  const collect = createCollector(async () => quota(remaining), () => now);
  assert.equal((await collect(false)).quota?.usedPercent, 25);
  remaining = 60; now = 50000;
  const cached = await collect(false);
  assert.equal(cached.quota?.usedPercent, 25);
  assert.equal(cached.observedAt, 100);
  assert.equal((await collect(true)).quota?.usedPercent, 40);
  remaining = 45; now = 110000;
  assert.equal((await collect(false)).quota?.usedPercent, 55);
});

test('concurrent reads share a fresh measurement', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let reads = 0;
  const collect = createCollector(async () => { reads++; await gate; return quota(90); }, () => 123);
  const a = collect(true), b = collect(true);
  release();
  assert.deepEqual(await a, await b);
  assert.equal((await b).quota?.remainingPercent, 90);
  assert.equal(reads, 1);
});

test('an error retains the last successful timestamp, never a stale percentage or secret', async () => {
  let fail = false, now = 100;
  const collect = createCollector(async () => {
    if (fail) throw new Error('sensitive transport details');
    return quota(70);
  }, () => now);
  await collect(true); fail = true; now = 200;
  const sample = await collect(true);
  assert.equal(sample.status, 'error');
  assert.equal(sample.observedAt, 100);
  assert.equal(sample.quota, undefined);
  assert.equal(JSON.stringify(sample).includes('sensitive'), false);
});

test('known sign-in failure remains unavailable before the first measurement', async () => {
  const collect = createCollector(async () => { throw new QuotaError('sign_in_required'); });
  const sample = await collect(false);
  assert.deepEqual(sample, { status: 'error', observedAt: null, code: 'sign_in_required' });
});
