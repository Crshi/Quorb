/* quorb · 契约验证（docs/architecture.md §3 / §10-P3）
 * 遍历 registry：描述符形状断言（id/label/icon/authMode/configSchema/fetchUsage/consoleUrl）
 * + listProviders 摘要必须能过消息总线（JSON 序列化后仍保留校验约束）
 * + 每个 provider 用自带 fixtures 跑 fetchUsage 回归。
 * 新增服务商时无需改本文件：形状检查自动覆盖新适配器，fixtures 回归放各自用例。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { REGISTRY, listProviders } from '../../src/providers/registry.js';
import { PROVIDER_ICONS } from '../../src/shared/icons.js';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = name => JSON.parse(readFileSync(join(here, '../fixtures', name), 'utf8'));

const FIELD_TYPES = new Set(['password', 'text', 'segment']);
const AUTH_MODES = new Set(['manual', 'session']);
const WINDOW_KINDS = new Set(['rolling', 'fixed']);

const fakeFetch = respond => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(respond) });

/* ---------- 描述符形状（对 registry 里每个 provider 生效） ---------- */
for (const p of Object.values(REGISTRY)) {
  test('契约形状：' + p.id, () => {
    assert.equal(typeof p.id, 'string');
    assert.match(p.id, /^[a-z][a-z0-9]*$/);            // 稳定标识：进存储，发布后不可变更
    assert.ok(p.label, 'label 必填');
    assert.ok(PROVIDER_ICONS[p.icon], 'icon 必须在 shared/icons.js PROVIDER_ICONS 注册');
    assert.ok(AUTH_MODES.has(p.authMode), "authMode ∈ 'manual' | 'session'");
    assert.equal(typeof p.fetchUsage, 'function');
    assert.ok(typeof p.consoleUrl === 'function' || typeof p.consoleUrl === 'string');

    const fields = p.configSchema?.fields;
    assert.ok(Array.isArray(fields) && fields.length > 0, 'configSchema.fields 必填');
    for (const f of fields) {
      assert.ok(FIELD_TYPES.has(f.type), '字段类型 ∈ password | text | segment');
      assert.ok(f.name && f.label, 'name/label 必填');
      if (f.type === 'segment') {
        assert.ok(Array.isArray(f.options) && f.options.length >= 2, 'segment 至少两个选项');
        for (const o of f.options) assert.ok(o.value != null && o.label, '选项需 value/label');
      }
      if (f.required) assert.ok(f.label, 'required 字段必须有 label（校验提示依赖它）');
      /* validate 是函数、过不了消息总线；可序列化约束必须足以让向导完成前置校验 */
      const plain = JSON.parse(JSON.stringify(f));
      if (f.required) assert.equal(plain.required, true);
      if (f.minLength) assert.equal(plain.minLength, f.minLength);
      if (f.placeholder) assert.equal(plain.placeholder, f.placeholder);
    }
  });
}

test('listProviders 摘要：与 registry 一致且可 JSON 序列化', () => {
  const rt = JSON.parse(JSON.stringify(listProviders()));
  assert.equal(rt.length, Object.keys(REGISTRY).length);
  for (const s of rt) {
    assert.ok(REGISTRY[s.id], '摘要 id 必须能查回注册表');
    assert.ok(s.label && s.icon);
    assert.ok(Array.isArray(s.configSchema.fields) && s.configSchema.fields.length > 0);
    for (const f of s.configSchema.fields) assert.ok(f.name && f.label);
  }
});

/* ---------- glm fixtures 回归（脱敏样本；协议语义见 src/providers/glm.js 头注） ---------- */
const glm = REGISTRY.glm;

test('glm · team-double：双窗归一，percentage 是「已用」整数语义', async () => {
  const r = await glm.fetchUsage(
    { region: 'bigmodel', apiKey: 'k' },
    { fetchImpl: fakeFetch(loadFixture('glm-team-double.json')) },
  );
  assert.equal(r.ok, true);
  const [h5, week] = r.snapshot.windows;
  assert.equal(r.snapshot.windows.length, 2);
  assert.equal(h5.label, '5 小时窗口');
  assert.equal(h5.pct, 38);                          // percentage=62（已用）→ 剩余 38
  assert.equal(h5.left, 76);
  assert.equal(h5.kind, 'rolling');
  assert.equal(week.label, '本周');
  assert.equal(week.pct, 48);                        // percentage=52 → 剩余 48
  assert.match(r.snapshot.plan, /GLM Coding/);
  /* 归一化窗口结构不变式（§3.2，跨服务商稳定） */
  for (const w of r.snapshot.windows) {
    assert.ok(w.id && w.label);
    assert.ok(WINDOW_KINDS.has(w.kind));
    assert.ok(typeof w.pct === 'number' && w.pct >= 0 && w.pct <= 100);
    assert.ok('used' in w && 'limit' in w && 'left' in w);
  }
});

test('glm · personal-noplan：error.kind=noPlan，attempts 保留', async () => {
  const r = await glm.fetchUsage(
    { apiKey: 'k' },
    { fetchImpl: fakeFetch(loadFixture('glm-personal-noplan.json')) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'noPlan');
  assert.ok(Array.isArray(r.error.attempts) && r.error.attempts.length > 0);
});

test('glm · team-empty（带 org/project 上下文）：error.kind=context', async () => {
  const r = await glm.fetchUsage(
    { apiKey: 'k', organization: 'org-x', project: 'proj_x' },
    { fetchImpl: fakeFetch(loadFixture('glm-team-empty.json')) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'context');
});

test('glm · 401：error.kind=auth', async () => {
  const fetch401 = async () => ({ ok: false, status: 401, text: async () => '' });
  const r = await glm.fetchUsage({ apiKey: 'k' }, { fetchImpl: fetch401 });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'auth');
});
