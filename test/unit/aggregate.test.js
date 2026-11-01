/* quorb · 聚合层单元测试：排除规则 1–5、跨连接最紧、stale 边界 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, staleThreshold } from '../../src/shared/aggregate.js';

const NOW = 1_000_000_000_000;
const now = () => NOW;
const conn = over => ({ id: 'a', provider: 'glm', label: 'A', enabled: true, pollMinutes: 5, status: { state: 'ok' }, ...over });
const snap = over => ({ ts: NOW - 60_000, windows: [{ id: 'h5', pct: 35 }, { id: 'week', pct: 38 }], ...over });

test('参与连接取全局最紧；binding 标注来源', () => {
  const out = aggregate([
    { conn: conn({ id: 'a' }), snapshot: snap() },
    { conn: conn({ id: 'b' }), snapshot: snap({ windows: [{ pct: 20 }] }) },
  ], { now });
  assert.equal(out.globalPct, 20);
  assert.equal(out.binding.connId, 'b');
  assert.equal(out.binding.pct, 20);
  assert.equal(out.connections.find(c => c.id === 'b').excluded, null);
});

test('规则1：disabled 排除，不进全局 min', () => {
  const out = aggregate([
    { conn: conn({ id: 'a', enabled: false }), snapshot: snap({ windows: [{ pct: 5 }] }) },
    { conn: conn({ id: 'b' }), snapshot: snap() },
  ], { now });
  assert.equal(out.globalPct, 35);
  assert.equal(out.connections.find(c => c.id === 'a').excluded, 'disabled');
});

test('规则2：auth / error 状态排除', () => {
  for (const state of ['auth', 'error']) {
    const out = aggregate([{ conn: conn({ status: { state } }), snapshot: snap({ windows: [{ pct: 1 }] }) }], { now });
    assert.equal(out.connections[0].excluded, state);
    assert.equal(out.globalPct, null);
  }
});

test('规则3：无快照排除（等待首次同步）', () => {
  const out = aggregate([{ conn: conn(), snapshot: null }], { now });
  assert.equal(out.connections[0].excluded, 'nosnap');
  assert.equal(out.globalPct, null);
});

test('规则4：过期排除并标 stale；边界值（恰好等于阈值）不过期', () => {
  const th = staleThreshold({ pollMinutes: 5 });   // max(10, 15) min = 15min
  assert.equal(th, 15 * 60_000);
  const out = aggregate([{ conn: conn(), snapshot: snap({ ts: NOW - th - 1 }) }], { now });
  assert.equal(out.connections[0].stale, true);
  assert.equal(out.connections[0].excluded, 'stale');
  assert.equal(out.globalPct, null);

  const edge = aggregate([{ conn: conn(), snapshot: snap({ ts: NOW - th }) }], { now });
  assert.equal(edge.connections[0].excluded, null);
  assert.equal(edge.globalPct, 35);
});

test('stale 阈值随轮询周期放大：poll=30 → 60 分钟', () => {
  assert.equal(staleThreshold({ pollMinutes: 30 }), 60 * 60_000);
});

test('全部排除 → globalPct=null；空输入安全', () => {
  assert.equal(aggregate([], { now }).globalPct, null);
  assert.equal(aggregate([{ conn: conn({ enabled: false }), snapshot: null }], { now }).globalPct, null);
});
