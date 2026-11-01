/* quorb · 连接管理单元测试：validateConfig 语义 + saveConnection 新建/编辑合并/失败不落盘 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, saveConnection } from '../../src/background/connections.js';

let fetchCalls = [];
const provider = {
  id: 'fake',
  label: 'Fake Plan',
  configSchema: {
    fields: [
      { name: 'region', type: 'segment', label: '区域', default: 'r1', options: [{ value: 'r1', label: 'R1' }] },
      { name: 'apiKey', type: 'password', label: 'API Key', required: true, minLength: 8 },
      { name: 'org', type: 'text', label: '组织 ID' },
    ],
  },
  async fetchUsage(config) {
    fetchCalls.push({ ...config });
    return { ok: true, snapshot: { plan: 'P', windows: [{ id: 'w', pct: 50 }], endpoint: 'https://x', raw: {} } };
  },
};

function memStorage(initial = {}) {
  const m = { ...initial };
  return {
    m,
    async getConnection(id) { return m['conn:' + id] || null; },
    async setConnection(c) { m['conn:' + c.id] = c; },
    async setSnap(id, s) { m['snap:' + id] = s; },
  };
}
const deps = storage => ({ registry: { fake: provider }, storage, genId: () => 'c_new', version: () => '0.6.0' });

test('validateConfig：required / minLength / 通过', () => {
  assert.match(validateConfig(provider, {}), /请填写API Key/);
  assert.match(validateConfig(provider, { apiKey: 'short' }), /至少 8/);
  assert.equal(validateConfig(provider, { apiKey: 'longenough' }), null);
});

test('saveConnection 新建：先验证后落盘，写 conn + snap（gen 来自注入版本）', async () => {
  fetchCalls = [];
  const st = memStorage();
  const r = await saveConnection({ provider: 'fake', config: { region: 'r1', apiKey: 'abcd12345', org: 'o' } }, deps(st));
  assert.equal(r.ok, true);
  assert.equal(r.id, 'c_new');
  assert.equal(st.m['conn:c_new'].config.apiKey, 'abcd12345');
  assert.equal(st.m['snap:c_new'].windows[0].pct, 50);
  assert.equal(st.m['snap:c_new'].gen, '0.6.0');
  assert.deepEqual(fetchCalls[0], { region: 'r1', apiKey: 'abcd12345', org: 'o' });
});

test('saveConnection 编辑：password 留空保留旧凭据；text 留空按清空处理', async () => {
  fetchCalls = [];
  const st = memStorage({
    'conn:old': { id: 'old', provider: 'fake', label: 'L', enabled: true, config: { region: 'r1', apiKey: 'storedkey99', org: 'keepme' }, pollMinutes: 5 },
  });
  const r = await saveConnection({ id: 'old', provider: 'fake', label: 'L2', config: { region: 'r1', apiKey: '', org: '' } }, deps(st));
  assert.equal(r.ok, true);
  const cfg = st.m['conn:old'].config;
  assert.equal(cfg.apiKey, 'storedkey99');   // 凭据留空 = 保持（凭据从不回传 UI）
  assert.equal(cfg.org, '');                 // 非凭据字段允许清空
  assert.equal(st.m['conn:old'].label, 'L2');
  assert.deepEqual(fetchCalls[0], { region: 'r1', apiKey: 'storedkey99', org: '' });
});

test('saveConnection 验证失败：不落盘，错误 kind 透传', async () => {
  fetchCalls = [];
  const bad = { ...provider, async fetchUsage() { return { ok: false, error: { kind: 'auth', message: 'bad key' } }; } };
  const st = memStorage();
  const r = await saveConnection(
    { provider: 'fake', config: { apiKey: 'abcd12345' } },
    { registry: { fake: bad }, storage: st, genId: () => 'c_new', version: () => '0' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth');
  assert.equal(Object.keys(st.m).length, 0);
});
