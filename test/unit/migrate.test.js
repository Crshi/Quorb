/* quorb · v1→v2 迁移规划单元测试 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planMigration } from '../../src/lib/migrate.js';

test('有 Key：建 glm 连接，snap/位置/隐藏站点随迁，旧状态保留', () => {
  const snap = { ts: 123456, gen: '0.4.0', endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2', plan: 'GLM Coding · max', windows: [{ id: 'h5', pct: 35 }], raw: {} };
  const out = planMigration({
    cfg: { region: 'bigmodel', apiKey: 'id.secret', organization: 'org-1', project: 'proj_1', pollMinutes: 15, pos: { x: 1, y: 2 }, docked: 'right', hiddenOrigins: ['https://a.com'] },
    snap,
    status: { state: 'ok', message: '', ts: 123456 },
  });
  assert.equal(out.connId, 'c_migrated');
  const conn = out.writes['conn:c_migrated'];
  assert.equal(conn.provider, 'glm');
  assert.equal(conn.config.apiKey, 'id.secret');
  assert.equal(conn.config.organization, 'org-1');
  assert.equal(conn.pollMinutes, 15);
  assert.equal(conn.lastSyncAt, 123456);
  assert.deepEqual(out.writes['snap:c_migrated'], snap);
  assert.deepEqual(out.writes.ui, { orbScope: 'all', pos: { x: 1, y: 2 }, docked: 'right', hiddenOrigins: ['https://a.com'], order: ['c_migrated'] });
  assert.deepEqual(out.writes.meta, { schemaVersion: 2 });
});

test('无 Key：只推进 schemaVersion，不建连接，孤儿 snap 丢弃', () => {
  const out = planMigration({ cfg: { region: 'bigmodel', apiKey: '' }, snap: { ts: 1 }, status: { state: 'nokey' } });
  assert.equal(out.connId, null);
  assert.deepEqual(Object.keys(out.writes), ['meta']);
  assert.deepEqual(out.writes.meta, { schemaVersion: 2 });
});

test('完全空态（全新安装）：同样只写 meta，幂等安全', () => {
  const out = planMigration({});
  assert.equal(out.connId, null);
  assert.deepEqual(out.writes, { meta: { schemaVersion: 2 } });
});

test('非法 v1 状态归一为 ok；缺省字段取默认', () => {
  const out = planMigration({ cfg: { apiKey: 'id.secret' } });
  const conn = out.writes['conn:c_migrated'];
  assert.equal(conn.config.region, 'bigmodel');
  assert.equal(conn.config.organization, '');
  assert.equal(conn.pollMinutes, 5);
  assert.equal(conn.status.state, 'ok');
  assert.deepEqual(out.writes.ui.hiddenOrigins, []);
});
