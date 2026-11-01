/* quorb · 同步编排（docs/architecture.md §5）
 * 单一 1 分钟 alarm tick + 到期过滤（SW 侧接线）；连接之间错误互不传染。
 * 依赖（registry / storage / now / version）全部可注入 → node --test 可测。 */
import { listConnections, setConnection, setSnap, manifestVersion } from '../lib/store.js';
import { REGISTRY } from '../providers/registry.js';

const DEFAULTS = () => ({
  registry: REGISTRY,
  storage: { listConnections, setConnection, setSnap },
  now: Date.now,
  version: manifestVersion,
});

export function isDue(conn, now) {
  return !conn.lastSyncAt || now - conn.lastSyncAt >= Math.max(1, conn.pollMinutes || 5) * 60_000;
}

/** 同步单条连接：状态流转 syncing → ok / auth / error，lastSyncAt 记录尝试时刻
 *  （失败也推进，避免 tick 对失联连接每分钟重试）。 */
export async function syncConnection(conn, deps = {}) {
  const d = { ...DEFAULTS(), ...deps };
  const provider = d.registry[conn.provider];
  if (!provider) {
    await d.storage.setConnection({ ...conn, status: { state: 'error', message: '未注册的服务商：' + conn.provider, ts: d.now() } });
    return { ok: false, error: { kind: 'unknown', message: '未注册的服务商：' + conn.provider } };
  }
  await d.storage.setConnection({ ...conn, status: { state: 'syncing', message: '', ts: d.now() } });
  try {
    const r = await provider.fetchUsage(conn.config, { fetchImpl: d.fetchImpl, now: d.now });
    if (r.ok) {
      const ts = d.now();
      const snap = {
        ts,
        gen: d.version(),
        endpoint: r.snapshot.endpoint,
        plan: r.snapshot.plan,
        windows: r.snapshot.windows,
        raw: r.snapshot.raw,
      };
      await d.storage.setSnap(conn.id, snap);
      await d.storage.setConnection({ ...conn, lastSyncAt: ts, status: { state: 'ok', message: '', ts } });
      return { ok: true, windows: snap.windows, plan: snap.plan };
    }
    const kind = r.error?.kind || 'unknown';
    const state = kind === 'auth' ? 'auth' : 'error';
    await d.storage.setConnection({ ...conn, lastSyncAt: d.now(), status: { state, message: r.error?.message || '', ts: d.now() } });
    return { ok: false, error: r.error };
  } catch (e) {
    const msg = String(e && e.message || e);
    await d.storage.setConnection({ ...conn, lastSyncAt: d.now(), status: { state: 'error', message: msg, ts: d.now() } });
    return { ok: false, error: { kind: 'network', message: msg } };
  }
}

/** tick 入口：列出连接 → 过期(enabled)过滤 → 并行同步（allSettled 双保险隔离异常）。 */
export async function syncDue(trigger = 'tick', deps = {}) {
  const d = { ...DEFAULTS(), ...deps };
  const conns = await d.storage.listConnections();
  const t = d.now();
  const due = conns.filter(c => c.enabled !== false && isDue(c, t));
  console.info('[quorb][sw] sync(' + trigger + ') due ' + due.length + '/' + conns.length);
  const results = await Promise.allSettled(due.map(c => syncConnection(c, deps)));
  const flat = results.map(r => (r.status === 'fulfilled' ? r.value : { ok: false, error: { kind: 'unknown', message: String(r.reason) } }));
  const okCount = flat.filter(r => r.ok).length;
  return { ok: okCount > 0, synced: okCount, total: due.length, results: flat };
}
