/* quorb · 同步编排单元测试：到期过滤、错误隔离、状态流转 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDue, syncConnection, syncDue } from '../../src/background/orchestrator.js';

const NOW = 1_000_000_000_000;
const now = () => NOW;

function makeStorage() {
  const state = { conns: {}, snaps: {} };
  return {
    state,
    listConnections: async () => Object.values(state.conns),
    getConnection: async id => state.conns[id] || null,
    setConnection: async c => { state.conns[c.id] = c; },
    setSnap: async (id, s) => { state.snaps[id] = s; },
  };
}

const okProvider = windows => ({
  id: 'fake',
  fetchUsage: async () => ({ ok: true, snapshot: { plan: 'P', windows: windows || [{ id: 'h5', pct: 40 }], endpoint: 'https://x/y', raw: {} } }),
});
const authFailProvider = {
  id: 'fake',
  fetchUsage: async () => ({ ok: false, error: { kind: 'auth', message: '鉴权失败' } }),
};

const DEPS = storage => ({ storage, now, version: () => 'test-1', registry: {} });

test('isDue：无 lastSyncAt 视为到期；未到周期不重试', () => {
  assert.equal(isDue({ pollMinutes: 5 }, NOW), true);
  assert.equal(isDue({ pollMinutes: 5, lastSyncAt: NOW - 4 * 60_000 }, NOW), false);
  assert.equal(isDue({ pollMinutes: 5, lastSyncAt: NOW - 5 * 60_000 }, NOW), true);
});

test('syncConnection：成功流转 syncing→ok，写 snap（gen 来自注入版本）', async () => {
  const storage = makeStorage();
  const conn = { id: 'a', provider: 'ok', config: {}, pollMinutes: 5, lastSyncAt: 0, status: { state: 'ok' } };
  const r = await syncConnection(conn, { ...DEPS(storage), registry: { ok: okProvider() } });
  assert.equal(r.ok, true);
  assert.equal(storage.state.snaps.a.gen, 'test-1');
  assert.equal(storage.state.snaps.a.windows[0].pct, 40);
  assert.equal(storage.state.conns.a.status.state, 'ok');
  assert.equal(storage.state.conns.a.lastSyncAt, NOW);
});

test('syncConnection：auth 失败 → 状态 auth、lastSyncAt 仍推进（避免每分钟重试）', async () => {
  const storage = makeStorage();
  const conn = { id: 'a', provider: 'bad', config: {}, pollMinutes: 5, lastSyncAt: 0, status: { state: 'ok' } };
  const r = await syncConnection(conn, { ...DEPS(storage), registry: { bad: authFailProvider } });
  assert.equal(r.ok, false);
  assert.equal(storage.state.conns.a.status.state, 'auth');
  assert.equal(storage.state.conns.a.lastSyncAt, NOW);
  assert.equal(storage.state.snaps.a, undefined);
});

test('syncConnection：provider 抛异常 → error 状态，不外溢', async () => {
  const storage = makeStorage();
  const throwing = { id: 't', fetchUsage: async () => { throw new Error('net down'); } };
  const r = await syncConnection({ id: 'a', provider: 't', config: {} }, { ...DEPS(storage), registry: { t: throwing } });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'network');
  assert.equal(storage.state.conns.a.status.state, 'error');
});

test('syncDue：只同步到期且启用的连接；错误互不传染', async () => {
  const storage = makeStorage();
  await storage.setConnection({ id: 'due-ok', provider: 'ok', enabled: true, pollMinutes: 5, lastSyncAt: 0, config: {} });
  await storage.setConnection({ id: 'due-auth', provider: 'bad', enabled: true, pollMinutes: 5, lastSyncAt: 0, config: {} });
  await storage.setConnection({ id: 'not-due', provider: 'never', enabled: true, pollMinutes: 5, lastSyncAt: NOW - 60_000, config: {} });
  await storage.setConnection({ id: 'disabled', provider: 'never', enabled: false, pollMinutes: 5, lastSyncAt: 0, config: {} });

  const r = await syncDue('test', {
    ...DEPS(storage),
    registry: { ok: okProvider(), bad: authFailProvider, never: okProvider() },
  });
  assert.equal(r.total, 2);                     // due-ok + due-auth
  assert.equal(r.synced, 1);
  assert.equal(storage.state.conns['due-ok'].status.state, 'ok');
  assert.equal(storage.state.conns['due-auth'].status.state, 'auth');
  assert.equal(storage.state.conns['not-due'].provider, 'never');   // 未被触碰
  assert.equal(storage.state.snaps['not-due'], undefined);
  assert.equal(storage.state.snaps['disabled'], undefined);
});
