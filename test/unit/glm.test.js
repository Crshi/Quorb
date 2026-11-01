/* quorb · GLM 适配器单元测试（fixtures 为脱敏实测形态样本） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import glm, { fetchRawUsage, normalizeUsage, isZhipuPairKey } from '../../src/providers/glm.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fx = name => JSON.parse(readFileSync(path.join(dir, '../fixtures', name), 'utf8'));
const DOUBLE = fx('glm-team-double.json');
const PERSONAL = fx('glm-personal-tokens.json');
const NOPLAN = fx('glm-personal-noplan.json');
const EMPTY = fx('glm-team-empty.json');

/* 按 url 尾参 type 分发响应的假 fetch */
function fakeFetch(map, { status = 200 } = {}) {
  const calls = [];
  const impl = async url => {
    calls.push(url);
    const m = url.match(/type=(\d)$/);
    const body = map[m ? m[1] : '?'] ?? NOPLAN;
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  impl.calls = calls;
  return impl;
}

test('normalizeUsage：双窗归一（percentage 为已用整数，非 0–1 比例）', () => {
  const a = normalizeUsage(DOUBLE);
  assert.equal(a.windows.length, 2);
  assert.equal(a.windows[0].label, '5 小时窗口');
  assert.equal(a.windows[0].pct, 38);          // 已用 62 → 剩余 38
  assert.equal(a.windows[0].left, 76);
  assert.equal(a.windows[0].kind, 'rolling');
  assert.equal(a.windows[1].label, '本周');
  assert.equal(a.windows[1].pct, 48);
  assert.equal(a.plan, 'GLM Coding · GLM Coding Pro');
});

test('normalizeUsage：个人版 TOKENS_LIMIT 双窗（无绝对用量）并忽略 TIME_LIMIT', () => {
  const a = normalizeUsage(PERSONAL);
  assert.equal(a.windows.length, 2);
  assert.equal(a.windows[0].label, '5 小时窗口');
  assert.equal(a.windows[0].pct, 98);          // 已用 2 → 剩余 98
  assert.equal(a.windows[0].kind, 'rolling');
  assert.equal(a.windows[1].label, '本周');
  assert.equal(a.windows[1].pct, 86);          // 已用 14 → 剩余 86
  assert.equal(a.windows[1].kind, 'fixed');
  assert.equal(a.plan, 'GLM Coding · pro');
  /* 个人版响应只有百分比，绝对用量字段可缺失；TIME_LIMIT（MCP 月度计数）不得混入窗口 */
  assert.equal(a.windows[0].used, undefined);
  assert.ok(a.windows.every(w => w.label !== '窗口 u5×1'));
});

test('normalizeUsage：percentage=1 应得剩余 99%（防误判为已用 100%）', () => {
  const e = normalizeUsage({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 1200, currentValue: 12, remaining: 1188, percentage: 1 }] } });
  assert.equal(e.windows[0].pct, 99);
});

test('normalizeUsage：无套餐 / 空上下文 / TIME_LIMIT / 未知类型 → 0 窗口', () => {
  assert.equal(normalizeUsage(NOPLAN).windows.length, 0);
  assert.equal(normalizeUsage(EMPTY).windows.length, 0);
  assert.equal(normalizeUsage({ data: { limits: [{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 10 }] } }).windows.length, 0);
  assert.equal(normalizeUsage({ data: { limits: [{ type: 'SOMETHING_ELSE', unit: 3, number: 5, percentage: 10 }] } }).windows.length, 0);
});

test('探测顺序：个人先不带 type 再回退 1/2；团队先 type=2', async () => {
  const f1 = fakeFetch({ 1: NOPLAN, 2: DOUBLE });
  const r1 = await fetchRawUsage({ apiKey: 'k', fetchImpl: f1 });
  assert.equal(r1.ok, true);
  assert.equal(r1.planType, 2);
  assert.equal(f1.calls.length, 3);
  assert.ok(!f1.calls[0].includes('type='), '个人主路径第一次请求不应带 type');
  assert.match(f1.calls[1], /type=1$/);
  assert.match(f1.calls[2], /type=2$/);

  const fp = fakeFetch({ '?': PERSONAL });
  const rp = await fetchRawUsage({ apiKey: 'k', fetchImpl: fp });
  assert.equal(rp.ok, true);
  assert.equal(rp.planType, null);
  assert.equal(fp.calls.length, 1, '个人主路径命中后不再探测');
  assert.ok(!fp.calls[0].includes('type='));

  const f2 = fakeFetch({ 1: NOPLAN, 2: DOUBLE });
  await fetchRawUsage({ apiKey: 'k', organization: 'org-x', project: 'proj_x', fetchImpl: f2 });
  assert.deepEqual(f2.calls.map(u => u.slice(-1)), ['2']);
});

test('fetchUsage 契约：个人账号（不带 type + TOKENS_LIMIT）→ 归一化 snapshot', async () => {
  const r = await glm.fetchUsage({ region: 'bigmodel', apiKey: 'k' }, { fetchImpl: fakeFetch({ '?': PERSONAL }) });
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.windows.length, 2);
  assert.equal(r.snapshot.windows[0].pct, 98);
  assert.equal(r.snapshot.windows[1].pct, 86);
  assert.equal(r.snapshot.plan, 'GLM Coding · pro');
  assert.ok(!r.snapshot.endpoint.includes('type='), '个人请求不带 type 参数');
});

test('fetchUsage 契约：团队账号（org/project + type=2）→ 归一化 snapshot', async () => {
  const r = await glm.fetchUsage({ apiKey: 'k', organization: 'org-x', project: 'proj_x' }, { fetchImpl: fakeFetch({ 2: DOUBLE }) });
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.windows.length, 2);
  assert.equal(r.snapshot.plan, 'GLM Coding · GLM Coding Pro');
  assert.match(r.snapshot.endpoint, /type=2$/);
});

test('fetchUsage 契约：401 → error.kind=auth', async () => {
  const r = await glm.fetchUsage({ apiKey: 'k' }, { fetchImpl: fakeFetch({ 1: DOUBLE }, { status: 401 }) });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'auth');
});

test('fetchUsage 契约：全 noPlan → kind=noPlan；空 data → kind=context', async () => {
  const r1 = await glm.fetchUsage({ apiKey: 'k' }, { fetchImpl: fakeFetch({ 1: NOPLAN, 2: NOPLAN }) });
  assert.equal(r1.error.kind, 'noPlan');

  const r2 = await glm.fetchUsage({ apiKey: 'k', organization: 'org-x', project: 'proj_x' }, { fetchImpl: fakeFetch({ 1: EMPTY, 2: EMPTY }) });
  assert.equal(r2.error.kind, 'context');
});

test('fetchUsage 契约：success 但只有 TIME_LIMIT（无套餐窗口）→ kind=parse', async () => {
  const onlyTime = { code: 200, msg: '操作成功', success: true, data: { limits: [{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 10 }] } };
  const r = await glm.fetchUsage({ apiKey: 'k' }, { fetchImpl: fakeFetch({ '?': onlyTime, 1: onlyTime, 2: onlyTime }) });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'parse');
  assert.match(r.error.message, /没有 5 小时 \/ 周用量窗口/);
});

test('fetchUsage 契约：网络抛错 → kind=network', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  const r = await glm.fetchUsage({ apiKey: 'k' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'network');
});

test('工具：isZhipuPairKey', () => {
  assert.equal(isZhipuPairKey('aaaa1111bbbb2222.cccc3333dddd4444'), true);
  assert.equal(isZhipuPairKey('sk-plain-key'), false);
});
