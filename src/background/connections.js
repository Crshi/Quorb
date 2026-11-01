/* quorb · 连接管理（docs/architecture.md §4/§7）
 * CRUD（先验证后落盘）· v1→v2 迁移落盘与旧键清理 · quorb/get 组装（v2 纯净结构）· 自检。
 * 安全红线：凭据只存 conn.config；消息响应只回传 safeConfig（password 字段只给「已保存」掩码）。
 * 可注入依赖（registry/storage/fetchImpl/genId/version）保证 node --test 可测。 */
import {
  get, set, remove, KEYS, getMeta, listConnections, getConnection, setConnection,
  delConnection, delSnap, setSnap, getSnap, genConnId, manifestVersion,
} from '../lib/store.js';
import { REGISTRY, listProviders } from '../providers/registry.js';
import { aggregate } from '../shared/aggregate.js';
import { planMigration } from '../lib/migrate.js';
import { syncConnection } from './orchestrator.js';

const DEFAULT_DEPS = () => ({
  registry: REGISTRY,
  storage: { getConnection, setConnection, setSnap },
  genId: genConnId,
  version: manifestVersion,
});

/* ---------- v1 → v2 迁移落盘（onInstalled 调用，幂等） ---------- */
export async function runMigration() {
  const meta = await getMeta();
  if (meta?.schemaVersion >= 2) return { migrated: false, reason: 'already' };
  const o = await get({ [KEYS.cfg]: null, [KEYS.snapshot]: null, [KEYS.status]: null });
  const plan = planMigration(
    { cfg: o[KEYS.cfg], snap: o[KEYS.snapshot], status: o[KEYS.status] },
    { id: genConnId() },
  );
  /* 记录迁移发生的扩展版本：cleanupV1Keys 依据「已跨过至少一个版本」才清理旧键（§4.2） */
  plan.writes.meta = { ...plan.writes.meta, migratedAt: manifestVersion() };
  await set(plan.writes);
  console.info('[quorb][sw] 存储迁移 v1→v2 完成 connId=' + plan.connId);
  return { migrated: true, connId: plan.connId };
}

/* ---------- 旧键清理：迁移版本 ≠ 当前版本 → cfg/snap/status 已安全跨版本，移除 ---------- */
export async function cleanupV1Keys() {
  const meta = await getMeta();
  const v = manifestVersion();
  /* migratedAt 缺失 = 在更早版本（0.5）完成的迁移，同样视为已跨版本 */
  if (meta?.schemaVersion >= 2 && (!meta.migratedAt || meta.migratedAt !== v)) {
    await remove([KEYS.cfg, KEYS.snapshot, KEYS.status]);
    console.info('[quorb][sw] v1 旧键已清理（迁移自 ' + (meta.migratedAt || '≤0.5') + ' → ' + v + '）');
    return { cleaned: true };
  }
  return { cleaned: false };
}

/* ---------- 表单校验（configSchema 驱动）
 * validate 是函数、过不了消息总线，因此向导侧按 required + minLength 等可序列化约束校验；
 * 这里两侧语义保持一致（minLength 与 validate 都认）。 ---------- */
export function validateConfig(provider, config = {}) {
  for (const f of provider.configSchema?.fields || []) {
    const raw = config[f.name];
    const v = typeof raw === 'string' ? raw.trim() : raw;
    if (f.required && !v) return '请填写' + f.label;
    if (v && f.minLength && String(v).length < f.minLength) return f.label + '至少 ' + f.minLength + ' 个字符';
    if (v && f.validate && !f.validate(v)) return f.label + '格式不正确';
  }
  return null;
}

/* ---------- CRUD：先验证后落盘 ---------- */
export async function saveConnection({ id, provider: providerId, label, config }, deps = {}) {
  const d = { ...DEFAULT_DEPS(), ...deps };
  const p = d.registry[providerId];
  if (!p) return { ok: false, message: '未注册的服务商：' + providerId };

  /* 编辑语义：凭据从不回传 UI，password 字段留空 = 保持已存凭据；其余字段留空按清空处理 */
  const existing = id ? await d.storage.getConnection(id) : null;
  const merged = { ...(config || {}) };
  if (existing) {
    for (const f of p.configSchema?.fields || []) {
      if (f.type === 'password' && !String(merged[f.name] ?? '').trim()) {
        merged[f.name] = existing.config?.[f.name] || '';
      }
    }
  }

  const invalid = validateConfig(p, merged);
  if (invalid) return { ok: false, message: invalid };

  const r = await p.fetchUsage(merged, { fetchImpl: deps.fetchImpl });
  if (!r.ok) {
    return { ok: false, kind: r.error?.kind, message: r.error?.message || '验证失败', attempts: r.error?.attempts };
  }

  const now = Date.now();
  const conn = existing
    ? { ...existing, provider: providerId, label: label || existing.label, config: merged, lastSyncAt: now, status: { state: 'ok', message: '', ts: now } }
    : { id: d.genId(), provider: providerId, label: label || p.label, enabled: true, config: merged, pollMinutes: 5, lastSyncAt: now, status: { state: 'ok', message: '', ts: now } };
  await d.storage.setConnection(conn);
  await d.storage.setSnap(conn.id, {
    ts: now, gen: d.version(), endpoint: r.snapshot.endpoint,
    plan: r.snapshot.plan, windows: r.snapshot.windows, raw: r.snapshot.raw,
  });
  return { ok: true, id: conn.id, windows: r.snapshot.windows, plan: r.snapshot.plan };
}

export async function deleteConnection(id) {
  await delConnection(id);
  await delSnap(id);
  return { ok: true };
}

export async function toggleConnection({ id, enabled }) {
  const conn = await getConnection(id);
  if (!conn) return { ok: false, message: '连接不存在' };
  const next = enabled ?? !conn.enabled;
  await setConnection({ ...conn, enabled: next });
  return { ok: true, enabled: next };
}

export async function setConnectionPoll({ id, minutes }) {
  const conn = await getConnection(id);
  if (!conn) return { ok: false, message: '连接不存在' };
  const m = Math.min(60, Math.max(1, minutes || 5));
  await setConnection({ ...conn, pollMinutes: m });
  return { ok: true, pollMinutes: m };
}

/* ---------- 手动刷新：跳过到期判断，并行同步全部启用连接 ---------- */
export async function refreshAll() {
  const conns = (await listConnections()).filter(c => c.enabled !== false);
  if (!conns.length) return { ok: false, reason: 'nokey', message: '还没有连接' };
  const results = await Promise.allSettled(conns.map(c => syncConnection(c)));
  const flat = results.map(r => (r.status === 'fulfilled' ? r.value : { ok: false, error: { kind: 'unknown', message: String(r.reason) } }));
  const okCount = flat.filter(r => r.ok).length;
  return okCount
    ? { ok: true, synced: okCount, total: conns.length }
    : { ok: false, message: flat.find(r => !r.ok)?.error?.message || '同步失败' };
}

/* ---------- safeConfig：非敏感字段原样；password 字段只回「已保存」掩码（§8.2/§8.4） ---------- */
function safeConfigOf(conn) {
  const p = REGISTRY[conn.provider];
  const out = {};
  for (const f of p?.configSchema?.fields || []) {
    const v = conn.config?.[f.name];
    out[f.name] = f.type === 'password' ? (v ? '••••••••' : '') : (v ?? '');
  }
  return out;
}

/* ---------- quorb/get：v2 纯净结构（P2 起 legacy 投影移除，D9 同进同退） ---------- */
export async function buildGetResponse() {
  const all = await get(null);
  const conns = Object.entries(all || {})
    .filter(([k]) => k.startsWith('conn:'))
    .map(([, v]) => v);
  const ui = all?.ui || { orbScope: 'all', pos: null, docked: null, hiddenOrigins: [], order: [] };
  const order = ui.order || [];
  conns.sort((a, b) => ((order.indexOf(a.id) + 1) || 1e9) - ((order.indexOf(b.id) + 1) || 1e9));

  const entries = conns.map(c => ({ conn: c, snapshot: all['snap:' + c.id] || null }));
  const agg = aggregate(entries);

  return {
    ok: true,
    schemaVersion: 2,
    connections: agg.connections.map(c => ({
      id: c.id, provider: c.provider, label: c.label, enabled: c.enabled !== false,
      status: c.status, plan: c.plan, windows: c.windows, ts: c.ts,
      gen: all['snap:' + c.id]?.gen || null,
      stale: c.stale, excluded: c.excluded, pct: c.pct, pollMinutes: c.pollMinutes,
      safeConfig: safeConfigOf(c),
    })),
    aggregate: { globalPct: agg.globalPct, binding: agg.binding },
    ui: {
      orbScope: ui.orbScope || 'all',
      pos: ui.pos || null,
      docked: ui.docked || null,
      hiddenOrigins: ui.hiddenOrigins || [],
      order,
    },
    providers: listProviders(),
  };
}

/* ---------- 调试：按连接取原始返回（raw 是接口响应，不含凭据，§8.4） ---------- */
export async function getSnapRaw(id) {
  const snap = await getSnap(id);
  if (!snap) return { ok: false, message: '该连接还没有快照' };
  return {
    ok: true,
    snap: { ts: snap.ts, gen: snap.gen, endpoint: snap.endpoint, plan: snap.plan, windows: snap.windows, raw: snap.raw },
  };
}

/* ---------- 自检：全局项 + 逐连接明细 ---------- */
export async function buildDiagnose(alarmScheduled) {
  const g = await buildGetResponse();
  return {
    ok: true,
    version: manifestVersion(),
    schemaVersion: 2,
    connectionCount: g.connections.length,
    alarmScheduled: !!alarmScheduled,
    hiddenOrigins: g.ui.hiddenOrigins,
    connections: g.connections.map(c => ({
      id: c.id, label: c.label, provider: c.provider, enabled: c.enabled,
      state: c.status?.state || 'ok', message: c.status?.message || '',
      stale: c.stale, excluded: c.excluded,
      windowsCount: c.windows?.length ?? 0, pollMinutes: c.pollMinutes, ts: c.ts,
    })),
  };
}
