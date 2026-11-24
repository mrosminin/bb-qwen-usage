export interface Quota {
  remainingPercent: number;
  usedPercent: number;
  resetText: string | null;
}

export const QUOTA_URL = 'https://chat.qwen.ai/settings/usage-billing';

export class QuotaError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function parseQuota(snapshot: unknown): Quota {
  const s = record(snapshot);
  let url: URL;
  try { url = new URL(String(s.url)); } catch { throw new QuotaError('unexpected_page'); }
  if (url.origin !== 'https://chat.qwen.ai' || url.pathname !== '/settings/usage-billing' || url.username) {
    throw new QuotaError('unexpected_page');
  }
  if (s.phase !== 'ready') throw new QuotaError('not_ready');

  const raw = record(s.weekly).remaining;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) throw new QuotaError('invalid_quota');
  const remainingPercent = Number(raw);
  if (!Number.isFinite(remainingPercent) || remainingPercent > 100) throw new QuotaError('invalid_quota');

  return {
    remainingPercent,
    usedPercent: Math.round((100 - remainingPercent) * 1e6) / 1e6,
    resetText: typeof s.resetText === 'string' ? s.resetText.slice(0, 160) : null,
  };
}
