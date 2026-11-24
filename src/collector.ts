import { QuotaError, type Quota } from './quota.ts';

export interface Sample {
  status: 'ok' | 'error';
  observedAt: number | null;
  quota?: Quota;
  code?: string;
}

export function createCollector(read: () => Promise<Quota>, now = Date.now) {
  let cached: Sample | undefined;
  let cachedAt = 0;
  let observedAt: number | null = null;
  let pending: Promise<Sample> | null = null;
  const known = new Set(['sign_in_required', 'not_connected', 'tab_unavailable', 'desktop_unavailable',
    'browser_busy', 'browser_timeout', 'unexpected_page', 'not_ready', 'invalid_quota', 'page_load_failed']);

  return (refresh: boolean): Promise<Sample> => {
    if (pending) return pending;
    if (!refresh && cached && now() - cachedAt < 60000) return Promise.resolve(cached);
    pending = (async (): Promise<Sample> => {
      let sample: Sample;
      try {
        const quota = await read();
        observedAt = now();
        sample = { status: 'ok', observedAt, quota };
      } catch (e) {
        const code = e instanceof QuotaError && known.has(e.code) ? e.code : 'unavailable';
        sample = { status: 'error', observedAt, code };
      }
      cached = sample;
      cachedAt = now();
      return sample;
    })().finally(() => { pending = null; });
    return pending;
  };
}
