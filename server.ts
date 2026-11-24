import { cliCommand, defineCli, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { bbCommand, browserOptions, readBrowser, type Binding } from './src/browser.ts';
import { createCollector } from './src/collector.ts';
import { measurement } from './src/measurement.ts';
import { contract } from './src/usage-contract.ts';
import { QUOTA_URL, QuotaError, record } from './src/quota.ts';

const bindingSchema = z.object({
  hostId: z.string().regex(/^host_[a-zA-Z0-9]+$/),
  threadId: z.string().regex(/^thr_[a-zA-Z0-9]+$/),
  tabId: z.string().uuid(),
}).strict();
const locator = z.tuple([z.string().min(1)]);
const providerId = 'acp-qwen-code';

export default function plugin(bb: BbPluginApi) {
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  let collect: ReturnType<typeof createCollector> | undefined;
  let collectorKey = '';
  let connecting: Promise<Binding> | undefined;

  const binding = async () => {
    const value = await bb.storage.kv.get('binding');
    if (value === undefined) return undefined;
    const parsed = bindingSchema.safeParse(value);
    if (!parsed.success) throw new QuotaError('not_connected');
    return parsed.data;
  };
  const inventory = async () => {
    const hosts = await bb.sdk.hosts.list();
    const resources = await Promise.all(hosts.map(async host => {
      const providers = await bb.sdk.providers.list({ hostId: host.id });
      if (!providers.some(p => p.id === providerId)) return [];
      return [{ id: JSON.stringify([host.id]), accountKey: null, providerId, label: 'Qwen Code',
        scope: { kind: 'host' as const, hostId: host.id, hostName: host.name } }];
    }));
    return { resources: resources.flat() };
  };
  const sample = async (hostId: string, refresh: boolean) => {
    const saved = await binding();
    const key = JSON.stringify(saved ?? null);
    if (key !== collectorKey || !collect) {
      collectorKey = key;
      collect = createCollector(async () => {
        if (connecting) throw new QuotaError('browser_busy');
        if (!saved || saved.hostId !== hostId) throw new QuotaError('not_connected');
        return readBrowser(saved, lifetime.signal);
      });
    }
    if (saved && saved.hostId !== hostId) {
      return { status: 'error' as const, observedAt: null, code: 'not_connected' };
    }
    return collect(refresh);
  };
  const connect = async (threadId?: string) => {
    const saved = await binding();
    const hosts = (await bb.sdk.hosts.list()).filter(h => h.status === 'connected');
    // A local-only installation must not guess between machines.
    if (hosts.length !== 1) throw new QuotaError('desktop_unavailable');
    const hostId = hosts[0].id;
    const thread = threadId ?? saved?.threadId;
    if (!thread || !/^thr_[a-zA-Z0-9]+$/.test(thread)) throw new QuotaError('not_connected');
    if (saved && (saved.hostId !== hostId || saved.threadId !== thread)) {
      throw new QuotaError('not_connected');
    }
    const opts = await browserOptions({ hostId, threadId: thread }, lifetime.signal);
    const result = await bbCommand(['browser', 'tabs', ...opts], lifetime.signal);
    const tabs = Array.isArray(result.tabs) ? result.tabs.map(record) : [];
    let tabId = saved?.tabId;
    if (!tabId || !tabs.some(t => t.tabId === tabId)) {
      const created = await bbCommand(['browser', 'create', ...opts, '--url', QUOTA_URL], lifetime.signal);
      const tab = record(created.tab);
      if (typeof tab.tabId !== 'string') throw new QuotaError('tab_unavailable');
      tabId = tab.tabId;
    }
    const next = bindingSchema.parse({ hostId, threadId: thread, tabId });
    await bb.storage.kv.set('binding', next);
    collect = undefined;
    await bbCommand(['thread', 'open', next.threadId], lifetime.signal);
    await bbCommand(['browser', 'reveal', tabId, ...opts], lifetime.signal);
    return next;
  };

  bb.rpc.register(contract, {
    async 'provider-usage.v1.listResources'() { return inventory(); },
    async 'provider-usage.v1.getResource'({ resourceId, refresh }) {
      const [hostId] = locator.parse(JSON.parse(resourceId));
      const resources = await inventory();
      if (!resources.resources.some(r => r.id === resourceId)) throw new Error('Usage resource no longer exists.');
      return measurement(await sample(hostId, refresh));
    },
  }, { experimental_discoverable: true,
    experimental_description: 'Qwen subscription quota read from a dedicated BB browser tab. No model requests.' });

  const output = (value: unknown, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(value, null, 2) + '\n' });
  const failure = (error: unknown) => output({ ok: false,
    code: error instanceof QuotaError ? error.code : 'unavailable' }, 1);
  bb.cli.register(defineCli({
    name: 'qwen-usage', summary: 'Qwen Plus/Pro quota through a dedicated BB browser tab.',
    commands: {
      connect: cliCommand({
        summary: 'Open the dedicated tab; sign in to Qwen there yourself.',
        options: { thread: { type: 'string', description: 'Owner thread, required on first connection.' },
          json: { type: 'boolean', description: 'Print JSON.' } },
        async run({ options }, ctx) {
          try {
            connecting ??= connect(options.thread ?? ctx.threadId).finally(() => { connecting = undefined; });
            const next = await connecting;
            return output({ ok: true, ...next, message: 'Sign in to Qwen in this dedicated tab, then run status --refresh.' });
          } catch (error) { return failure(error); }
        },
      }),
      status: cliCommand({
        summary: 'Read quota; no model requests. Uses a 60-second cache.',
        options: { refresh: { type: 'boolean', description: 'Reload the quota page before reading.' },
          json: { type: 'boolean', description: 'Print JSON.' } },
        async run({ options }) {
          try {
            const saved = await binding();
            if (!saved) throw new QuotaError('not_connected');
            const result = await sample(saved.hostId, options.refresh);
            return output({ ...result, measurement: measurement(result) }, result.status === 'ok' ? 0 : 1);
          } catch (error) { return failure(error); }
        },
      }),
    },
  }));
}
