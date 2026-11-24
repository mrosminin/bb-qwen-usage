import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseQuota, QuotaError, QUOTA_URL, record, type Quota } from './quota.ts';
import { NAVIGATE_USAGE, SNAPSHOT } from './snapshot.ts';

export interface Binding { hostId: string; threadId: string; tabId: string }
type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
const exec = promisify(execFile);

export async function bbCommand(args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const result = await exec('/opt/homebrew/bin/bb', [...args, '--json'], {
      timeout: 15000, maxBuffer: 512000, signal,
    });
    return record(JSON.parse(result.stdout));
  } catch { throw new QuotaError('desktop_unavailable'); }
}

export function connectionUrl(value: unknown, host: string): string {
  const c = record(value);
  let url: URL;
  try { url = new URL(String(c.wsEndpoint)); } catch { throw new QuotaError('tab_unavailable'); }
  const expires = typeof c.expiresAt === 'number' ? c.expiresAt : Date.parse(String(c.expiresAt));
  if (c.hostId !== host || !Number.isFinite(expires) || expires <= Date.now()
    || !['ws:', 'wss:'].includes(url.protocol) || url.username || url.password
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new QuotaError('tab_unavailable');
  }
  return url.href;
}

export function ownedPage(value: unknown): string {
  const targets = record(value).targetInfos;
  const pages = Array.isArray(targets) ? targets.map(record).filter(t => t.type === 'page') : [];
  if (pages.length !== 1 || typeof pages[0].targetId !== 'string') throw new QuotaError('tab_unavailable');
  let url: URL;
  try { url = new URL(String(pages[0].url)); } catch { throw new QuotaError('unexpected_page'); }
  if (url.origin !== 'https://chat.qwen.ai') throw new QuotaError('sign_in_required');
  return pages[0].targetId;
}

export async function freshQuota(call: Call, wait = () => sleep(300), now = Date.now): Promise<Quota> {
  const snapshot = async () => {
    const result = record(await call('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true }));
    if (result.exceptionDetails) throw new QuotaError('page_load_failed');
    return record(record(result.result).value);
  };
  const before = await snapshot();
  if (before.phase === 'sign_in_required') throw new QuotaError('sign_in_required');
  if (![QUOTA_URL, 'https://chat.qwen.ai/', 'https://chat.qwen.ai/settings'].includes(String(before.url))) {
    throw new QuotaError('unexpected_page');
  }
  await call('Page.enable');
  const navigation = record(await call('Page.navigate', { url: QUOTA_URL }));
  if (navigation.errorText) throw new QuotaError('page_load_failed');
  const deadline = now() + 25000;
  let followedUsage = false;
  while (now() < deadline) {
    await wait();
    const next = await snapshot();
    if (!next.documentId || next.documentId === before.documentId) continue;
    if (next.phase === 'sign_in_required') throw new QuotaError('sign_in_required');
    if (next.phase === 'ready') return parseQuota(next);
    if (next.url === 'https://chat.qwen.ai/settings') {
      if (!followedUsage) {
        const action = record(await call('Runtime.evaluate', { expression: NAVIGATE_USAGE, returnByValue: true }));
        followedUsage = record(action.result).value === true;
      }
      continue;
    }
    if (next.url !== QUOTA_URL) throw new QuotaError('unexpected_page');
  }
  throw new QuotaError('browser_timeout');
}

async function connectCdp(endpoint: string, signal: AbortSignal) {
  const socket = new WebSocket(endpoint);
  let seq = 0;
  const pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  const close = () => {
    socket.close();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new QuotaError('tab_unavailable')); }
    pending.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  socket.addEventListener('message', event => {
    let d: Record<string, unknown>;
    try { d = record(JSON.parse(String(event.data))); } catch { return; }
    const p = pending.get(Number(d.id));
    if (!p) return;
    pending.delete(Number(d.id));
    clearTimeout(p.timer);
    if (d.error) p.reject(new QuotaError('tab_unavailable'));
    else p.resolve(d.result);
  });
  socket.addEventListener('close', close, { once: true });
  socket.addEventListener('error', close, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new QuotaError('browser_timeout')), 5000);
      const finish = () => clearTimeout(timer);
      socket.addEventListener('open', () => { finish(); resolve(); }, { once: true });
      socket.addEventListener('error', () => { finish(); reject(new QuotaError('tab_unavailable')); }, { once: true });
      socket.addEventListener('close', () => { finish(); reject(new QuotaError('tab_unavailable')); }, { once: true });
    });
  } catch (error) { close(); signal.removeEventListener('abort', close); throw error; }
  const call = (method: string, params = {}, sessionId?: string): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted || socket.readyState !== WebSocket.OPEN) return reject(new QuotaError('tab_unavailable'));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new QuotaError('browser_timeout')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { call, close: () => { signal.removeEventListener('abort', close); close(); } };
}

export async function browserOptions(binding: Pick<Binding, 'hostId' | 'threadId'>, signal?: AbortSignal) {
  const result = await bbCommand(['browser', 'instances', '--host', binding.hostId], signal);
  const instances = Array.isArray(result.instances) ? result.instances.map(record) : [];
  if (instances.length !== 1) throw new QuotaError('desktop_unavailable');
  const i = instances[0];
  if (typeof i.instanceId !== 'string' || typeof i.generation !== 'string') {
    throw new QuotaError('desktop_unavailable');
  }
  return ['--host', binding.hostId, '--instance', i.instanceId,
    '--generation', i.generation, '--thread', binding.threadId];
}

export async function readBrowser(binding: Binding, outerSignal: AbortSignal): Promise<Quota> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outerSignal.addEventListener('abort', abort, { once: true });
  if (outerSignal.aborted) controller.abort();
  const timer = setTimeout(abort, 55000);
  const signal = controller.signal;
  let opts: string[] = [];
  let lease: string | undefined;
  let temp: string | undefined;
  let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
  try {
    opts = await browserOptions(binding, signal);
    const result = await bbCommand(['browser', 'tabs', ...opts], signal);
    const tabs = Array.isArray(result.tabs) ? result.tabs.map(record) : [];
    const tab = tabs.find(t => t.tabId === binding.tabId);
    if (!tab) throw new QuotaError('tab_unavailable');
    if (tab.control) throw new QuotaError('browser_busy');
    const acquired = await bbCommand(['browser', 'acquire', binding.tabId, ...opts,
      '--controller', 'Qwen Usage', '--ttl-ms', '60000'], signal);
    if (typeof acquired.leaseId !== 'string') throw new QuotaError('tab_unavailable');
    lease = acquired.leaseId;
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-usage-cdp-'));
    await fs.chmod(temp, 0o700);
    const file = path.join(temp, 'connection.json');
    await bbCommand(['browser', 'connection', lease, ...opts, '--output', file], signal);
    const connection = JSON.parse(await fs.readFile(file, 'utf8'));
    cdp = await connectCdp(connectionUrl(connection, binding.hostId), signal);
    const targetId = ownedPage(await cdp.call('Target.getTargets'));
    const attached = record(await cdp.call('Target.attachToTarget', { targetId, flatten: true }));
    if (typeof attached.sessionId !== 'string') throw new QuotaError('tab_unavailable');
    const sessionId = attached.sessionId;
    const client = cdp;
    return await freshQuota((method, params) => client.call(method, params, sessionId));
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', abort);
    cdp?.close();
    // Cleanup must still run when the read was cancelled.
    if (lease) await bbCommand(['browser', 'release', lease, ...opts]).catch(() => {});
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}
