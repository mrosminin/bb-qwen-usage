// Narrow layouts return to Settings on reload; follow its visible read-only navigation.
export const NAVIGATE_USAGE = String.raw`(() => {
  if (location.origin !== 'https://chat.qwen.ai' || location.pathname !== '/settings') return false;
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const links = [...document.querySelectorAll('a,button,span,p,div')].filter(visible)
    .filter(e => !e.children.length && /^(Usage|Использование|使用情况|用量)$/i.test(e.textContent.trim()));
  if (links.length !== 1) return false;
  links[0].click();
  return true;
})()`;

// Only visible quota DOM leaves the page; authentication stays with the website.
export const SNAPSHOT = String.raw`(() => {
  const url = location.origin + location.pathname;
  const base = { url, documentId: performance.timeOrigin, phase: 'loading' };
  if (location.origin !== 'https://chat.qwen.ai') return { ...base, phase: 'sign_in_required' };
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const buttons = [...document.querySelectorAll('button,a,[role=button]')].filter(visible);
  const login = buttons.some(e => /^(log in|sign in|войти|вход|登录)$/i.test(e.textContent.trim()));
  const input = [...document.querySelectorAll('input[type=password],input[type=email]')].some(visible);
  if (login || input) return { ...base, phase: 'sign_in_required' };
  if (location.pathname !== '/settings/usage-billing') return base;
  const panels = [...document.querySelectorAll('[role=tabpanel]')].filter(visible);
  const panel = panels.find(e => /Qwen Code/.test(e.textContent) && /Deep Research/.test(e.textContent));
  if (!panel) return base;
  const bars = [...panel.querySelectorAll('[role=progressbar]')].filter(visible);
  const weekly = bars.filter(e => /weekly|недельн|周|每週/i.test(e.getAttribute('aria-label') || ''));
  if (weekly.length !== 1) return base;
  const bar = weekly[0];
  if (bar.getAttribute('aria-valuemin') !== '0' || bar.getAttribute('aria-valuemax') !== '100') return base;
  const reset = [...panel.querySelectorAll('span,p')].filter(visible)
    .map(e => e.textContent.trim()).find(t => t.length < 120 && /reset|сброс|重置/i.test(t) && /\d/.test(t));
  return { ...base, phase: 'ready', weekly: { remaining: bar.getAttribute('aria-valuenow') },
    resetText: reset || null };
})()`;
