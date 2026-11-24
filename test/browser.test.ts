import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionUrl, ownedPage, freshQuota } from '../src/browser.ts';
import { NAVIGATE_USAGE } from '../src/snapshot.ts';

test('rejects remote CDP endpoints, wrong host and expired leases', () => {
  const good = { hostId: 'h', expiresAt: Date.now() + 60000, wsEndpoint: 'ws://127.0.0.1:1234/lease' };
  assert.equal(connectionUrl(good, 'h'), 'ws://127.0.0.1:1234/lease');
  for (const patch of [
    { wsEndpoint: 'ws://example.com/lease' }, { wsEndpoint: 'http://127.0.0.1/' },
    { hostId: 'other' }, { expiresAt: 1 }, { wsEndpoint: 'ws://user:secret@localhost/lease' },
  ]) assert.throws(() => connectionUrl({ ...good, ...patch }, 'h'));
});

test('refuses ambiguous targets rather than reading another page', () => {
  const page = { type: 'page', targetId: 'own', url: 'https://chat.qwen.ai/' };
  assert.equal(ownedPage({ targetInfos: [page] }), 'own');
  assert.throws(() => ownedPage({ targetInfos: [page, { ...page, targetId: 'other' }] }));
  assert.throws(() => ownedPage({ targetInfos: [{ ...page, url: 'https://example.com/' }] }));
});

test('never returns old quota before the new document is ready', async () => {
  let navigated = false;
  let samples = 0;
  const call = async (method: string) => {
    if (method === 'Page.navigate') { navigated = true; return {}; }
    if (method !== 'Runtime.evaluate') return {};
    samples++;
    const changed = navigated && samples >= 4;
    return { result: { value: {
      url: 'https://chat.qwen.ai/settings/usage-billing', phase: 'ready',
      documentId: changed ? 200 : 100, weekly: { remaining: changed ? '80' : '99' },
    } } };
  };
  const result = await freshQuota(call, async () => {}, () => 0);
  assert.equal(result.usedPercent, 20);
  assert.equal(samples, 4);
});

test('stale document times out instead of returning its quota', async () => {
  let time = 0;
  const call = async (method: string) => method === 'Runtime.evaluate'
    ? { result: { value: { url: 'https://chat.qwen.ai/settings/usage-billing',
      phase: 'ready', documentId: 1, weekly: { remaining: '99' } } } } : {};
  await assert.rejects(freshQuota(call, async () => { time += 10000; }, () => time), /browser_timeout/);
});

test('signed-out page requires login without navigation', async () => {
  const call = async (method: string) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: { url: 'https://chat.qwen.ai/', phase: 'sign_in_required', documentId: 1 } } };
  };
  await assert.rejects(freshQuota(call), /sign_in_required/);
});

test('signed-in settings landing page can navigate to the quota page', async () => {
  let navigated = false;
  const call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.navigate') {
      assert.equal(params?.url, 'https://chat.qwen.ai/settings/usage-billing');
      navigated = true;
      return {};
    }
    if (method !== 'Runtime.evaluate') return {};
    return { result: { value: navigated ? {
      url: 'https://chat.qwen.ai/settings/usage-billing', phase: 'ready', documentId: 2,
      weekly: { remaining: '80' },
    } : { url: 'https://chat.qwen.ai/settings', phase: 'loading', documentId: 1 } } };
  };
  assert.equal((await freshQuota(call, async () => {})).usedPercent, 20);
});

test('fresh page redirected to settings follows only the visible Usage link', async () => {
  let reloaded = false;
  let clicked = false;
  const call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.navigate') { reloaded = true; return {}; }
    if (method !== 'Runtime.evaluate') return {};
    if (params?.expression === NAVIGATE_USAGE) {
      clicked = true;
      return { result: { value: true } };
    }
    return { result: { value: {
      url: clicked ? 'https://chat.qwen.ai/settings/usage-billing' : 'https://chat.qwen.ai/settings',
      documentId: reloaded ? 2 : 1, phase: clicked ? 'ready' : 'loading', weekly: { remaining: '95' },
    } } };
  };
  assert.equal((await freshQuota(call, async () => {})).usedPercent, 5);
});
