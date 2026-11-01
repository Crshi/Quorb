/* quorb · 多连接聚合（docs/architecture.md §6）
 * 三个 UI 端对「最紧窗口」的理解必须来自这里 —— 全局唯一实现。
 * 排除规则（按序判定）：disabled → auth/error → 无快照 → 过期(stale)。 */
import { bindingPct, bindingWin } from './format.js';

/* 过期阈值：max(2 × 轮询周期, 15 分钟)。失联连接不得用旧数据假装健康，
 * 也不能拖垮全局数字 —— 排除出全局 min，面板标「数据过期」。 */
export function staleThreshold(conn) {
  return Math.max(2 * (conn.pollMinutes || 5), 15) * 60_000;
}

/**
 * @param {{conn: object, snapshot?: object}[]} entries
 * @param {{now?: () => number}} opts
 */
export function aggregate(entries, { now = Date.now } = {}) {
  const t = now();
  const connections = (entries || []).map(({ conn, snapshot }) => {
    let excluded = null;
    if (conn.enabled === false) excluded = 'disabled';
    else if (conn.status?.state === 'auth' || conn.status?.state === 'error') excluded = conn.status.state;
    else if (!snapshot) excluded = 'nosnap';
    else if (t - snapshot.ts > staleThreshold(conn)) excluded = 'stale';
    const windows = snapshot?.windows || [];
    return {
      ...conn,
      windows,
      pct: bindingPct(windows),
      stale: excluded === 'stale',
      excluded,
      excludedWhy: excluded,
      ts: snapshot?.ts ?? null,
      plan: snapshot?.plan ?? null,
    };
  });

  const participants = connections.filter(c => !c.excluded && typeof c.pct === 'number');
  let binding = null;
  if (participants.length) {
    const b = participants.reduce((m, c) => (c.pct < m.pct ? c : m), participants[0]);
    binding = { connId: b.id, providerId: b.provider, pct: b.pct, window: bindingWin(b.windows) || null };
  }
  return { globalPct: binding ? binding.pct : null, binding, connections };
}
