/* quorb · 共享格式化与窗口计算
 * content / sidepanel / options 三端的唯一实现 —— 展示口径变更只改这里。
 * 阈值口径与设计稿一致：>45% 无色 · 21–45% warn · ≤20% crit。 */

export const fmt = n => n == null ? '—' : n.toLocaleString('en-US');

export function fmtSyncTime(ts) {
  if (!ts) return '尚未同步';
  const d = new Date(ts), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? `今天 ${hm}` : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

/* 重置语义：滚动窗口显示倒计时（2h 13m 后重置），固定周期显示时点（10/13 18:16 · 3 天） */
export function resetText(w) {
  if (!w?.resetAt) return '';
  const diff = w.resetAt - Date.now();
  if (diff <= 0) return '已重置 · 等待下次同步';
  if (w.kind === 'rolling') {
    const h = Math.floor(diff / 3.6e6), m = Math.floor((diff % 3.6e6) / 6e4);
    return h > 0 ? `${h}h ${m}m 后重置` : `${m} 分钟后重置`;
  }
  const d = new Date(w.resetAt);
  const days = Math.floor(diff / 864e5);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}${days > 0 ? ` · ${days} 天` : ''}`;
}

/* 最紧窗口：多窗口取剩余百分比最小者 */
export function bindingPct(windows) {
  const pcts = (windows || []).map(w => w.pct).filter(v => typeof v === 'number');
  return pcts.length ? Math.min(...pcts) : null;
}

export const bindingWin = (windows) => (windows || []).slice().sort((a, b) => (a.pct ?? 100) - (b.pct ?? 100))[0];

/* 阈值色判定：'' | 'warn' | 'crit' */
export function thresholdCls(p) {
  return p == null ? '' : p <= 20 ? 'crit' : p <= 45 ? 'warn' : '';
}
