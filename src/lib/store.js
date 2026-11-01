/* quorb · storage 封装（chrome.storage.local；密钥仅存本机，绝不使用 sync）
 * v2 键族（docs/architecture.md §4）：conn:<id> / snap:<id> / meta / ui
 * v1 单键（cfg/snap/status）仅作迁移数据源保留，0.6 清理。 */

const AREA = (typeof chrome !== 'undefined' && chrome.storage?.local) || null;

export async function get(keys) {
  if (!AREA) return {};
  return AREA.get(keys);
}
export async function set(obj) {
  if (!AREA) return;
  return AREA.set(obj);
}
export async function update(patch) {
  if (!AREA) return;
  return AREA.set(patch);
}
export async function remove(keys) {
  if (!AREA) return;
  return AREA.remove(keys);
}

export const KEYS = {
  cfg: 'cfg',         // v1：{ region, apiKey, pollMinutes, hiddenOrigins[] }
  snapshot: 'snap',   // v1：{ ts, endpoint, plan, windows[] }
  status: 'status',   // v1：{ state:'ok'|'error'|'nokey'|'syncing', message, ts }
};

export const V2 = {
  meta: 'meta',       // { schemaVersion }
  ui: 'ui',           // { orbScope, pos, docked, hiddenOrigins, order }
  connPrefix: 'conn:',
  snapPrefix: 'snap:',
};

export function manifestVersion() {
  try { return chrome.runtime.getManifest().version; } catch { return '0'; }
}

export function genConnId() {
  const raw = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return 'c_' + raw.replace(/-/g, '').slice(0, 10);
}

/* ---------- v2 助手 ---------- */
export async function getMeta() {
  const o = await get({ [V2.meta]: null });
  return o[V2.meta] || null;
}
export async function setMeta(meta) {
  await set({ [V2.meta]: meta });
}

export async function listConnections() {
  const all = await get(null);
  return Object.entries(all || {})
    .filter(([k]) => k.startsWith(V2.connPrefix))
    .map(([, v]) => v);
}
export async function getConnection(id) {
  const o = await get({ [V2.connPrefix + id]: null });
  return o[V2.connPrefix + id] || null;
}
export async function setConnection(conn) {
  await set({ [V2.connPrefix + conn.id]: conn });
}
export async function delConnection(id) {
  await AREA?.remove(V2.connPrefix + id);
}

export async function getSnap(id) {
  const o = await get({ [V2.snapPrefix + id]: null });
  return o[V2.snapPrefix + id] || null;
}
export async function setSnap(id, snap) {
  await set({ [V2.snapPrefix + id]: snap });
}
export async function delSnap(id) {
  await AREA?.remove(V2.snapPrefix + id);
}

export async function getUi() {
  const o = await get({ [V2.ui]: null });
  return o[V2.ui] || { orbScope: 'all', pos: null, docked: null, hiddenOrigins: [], order: [] };
}
export async function setUi(patch) {
  const cur = await getUi();
  await set({ [V2.ui]: { ...cur, ...patch } });
}

export async function getCfg() {
  const o = await get({ [KEYS.cfg]: null });
  const cfg = o[KEYS.cfg] || {};
  return {
    region: cfg.region || 'bigmodel',
    apiKey: cfg.apiKey || '',
    organization: cfg.organization || '',
    project: cfg.project || '',
    pollMinutes: cfg.pollMinutes || 5,
    hiddenOrigins: cfg.hiddenOrigins || [],
    pos: cfg.pos || null,
    docked: cfg.docked || null,
    ...cfg,
  };
}
export async function getStatus() {
  const o = await get({ [KEYS.status]: null });
  return o[KEYS.status] || { state: 'nokey', message: '' };
}
export async function getSnapshot() {
  const o = await get({ [KEYS.snapshot]: null });
  return o[KEYS.snapshot] || null;
}
