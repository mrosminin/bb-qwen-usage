import type { Sample } from './collector.ts';

const messages: Record<string, string> = {
  not_connected: 'Run bb qwen-usage connect --thread THREAD_ID to open the dedicated quota tab.',
  sign_in_required: 'Sign in to Qwen in the dedicated BB browser tab: bb qwen-usage connect.',
  tab_unavailable: 'Quota tab is unavailable. Open it with bb qwen-usage connect.',
  browser_busy: 'Quota tab is controlled by another browser session. Try again later.',
  desktop_unavailable: 'BB desktop browser is unavailable. Open BB on this Mac and try again.',
  browser_timeout: 'Qwen quota page did not finish loading. No current quota is available.',
};

export function measurement(sample: Sample) {
  const account = { accountEmail: null, planLabel: null, plan: null };
  return {
    accountKey: null,
    observedAt: sample.observedAt,
    usage: sample.status === 'ok' && sample.quota ? {
      status: 'ok' as const, ...account,
      windows: [{ id: 'weekly', label: 'Weekly limit', kind: 'weekly' as const,
        usedPercent: sample.quota.usedPercent, resetsAt: null, model: null, cost: null }],
    } : {
      status: 'error' as const, ...account,
      message: messages[sample.code ?? ''] ?? 'Qwen quota is unavailable. Check the dedicated quota tab.',
    },
  };
}
