/* quorb · v1 → v2 存储迁移规划（纯函数，node --test 直测）
 * 规则（docs/architecture.md §4.2）：
 *   - 旧 cfg.apiKey 存在 → 建一条 glm 连接，snap/位置/隐藏站点随迁
 *   - 旧 cfg 存在但无 apiKey → 不建连接，仅推进 schemaVersion（干净空态）
 *   - 无 cfg 的孤儿 snap 丢弃
 *   - 旧键原样保留（0.6 清理），升级出问题可回滚 0.4
 * SW 侧落盘在 connections.runMigration。 */

const KEEP_STATES = ['ok', 'syncing', 'auth', 'error'];

export function planMigration({ cfg, snap, status } = {}, { id = 'c_migrated' } = {}) {
  const writes = { meta: { schemaVersion: 2 } };

  if (!cfg || !cfg.apiKey) {
    return { connId: null, writes };
  }

  const st = status && KEEP_STATES.includes(status.state)
    ? { ...status }
    : { state: 'ok', message: '', ts: snap?.ts || 0 };

  const conn = {
    id,
    provider: 'glm',
    label: 'GLM Coding Plan',
    enabled: true,
    config: {
      region: cfg.region || 'bigmodel',
      apiKey: cfg.apiKey,
      organization: cfg.organization || '',
      project: cfg.project || '',
    },
    pollMinutes: cfg.pollMinutes || 5,
    lastSyncAt: snap?.ts || 0,
    status: st,
  };
  writes['conn:' + id] = conn;
  if (snap) writes['snap:' + id] = snap;
  writes.ui = {
    orbScope: 'all',
    pos: cfg.pos || null,
    docked: cfg.docked || null,
    hiddenOrigins: cfg.hiddenOrigins || [],
    order: [id],
  };
  return { connId: id, writes };
}
