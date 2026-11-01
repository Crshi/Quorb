# quorb 多服务商架构规划（v2）

> 目标：把 v0.4 的「GLM 单连接」演进为「多服务商 × 多连接」架构。
> **本期落地范围只带 GLM 一个真实适配器**；codex / claude / 火山引擎等作为未来适配器，
> 按第 11 节指南接入，届时不改 UI 与后台任何代码。多连接语义用
> 「GLM 个人版 + GLM 团队席位」双连接来验证，不需要第二个真实服务商。
>
> 状态：规划稿（2026-10）。各阶段验收标准见第 10 节。

---

## 1. 决策记录

先给结论，后文逐条展开。每条都列出了被放弃的替代方案，避免将来重新讨论已经论证过的问题。

| # | 议题 | 决策 | 理由 | 放弃的替代方案 |
|---|------|------|------|----------------|
| D1 | 抽象单位 | **多连接 Connection**：每条连接 = 服务商 × 一套凭据 × 配置 × 快照 | 用户可能同时有 GLM 个人 + GLM 团队 + 其它服务商；同一服务商也可能双账号 | 每服务商一个单例开关 |
| D2 | 契约边界 | 服务商协议与凭据知识**全部**进 `src/providers/*.js`；`windows[]` 归一化结构保持 v0.4 原样 | UI 已依赖该结构；接口变更隔离在单文件（GLM 实测经验） | 统一网关/中间层（当前规模下过度设计） |
| D3 | 凭据获取 | `authMode` 进入契约（`manual` 粘贴 / `session` 登录态捕获） | Claude 类服务商的用量只有登录态能读；差异最大的是凭据获取而非解析 | 所有服务商按 API Key 硬编码 |
| D4 | 存储结构 | **按连接分键**：`conn:<id>` / `snap:<id>`，另有 `meta` / `ui` | 多连接并行同步时避免单一大 map 键的读-改-写竞态；`onChanged` 事件粒度细 | 所有数据塞进一个键 |
| D5 | 定时同步 | 单一 **1 分钟 alarm tick + 到期过滤** | alarm 数量不随连接增长；tick 晚到即补跑（MV3 alarm 会被系统延迟），天然补偿 | 每连接注册一个 alarm |
| D6 | 构建链 | 引入 **esbuild**，仅打包 content script 一个入口 | 经典内容脚本不支持 ESM import；`src/shared/` 三端复用是消灭渲染重复的前提 | 零构建多文件 + globalThis 传值（脆弱）；webpack（太重） |
| D7 | 连接向导 | 由 `configSchema` **声明式渲染**表单 | 新增服务商零 UI 代码改动（第 11 节的验收就靠它） | 每服务商手写一页向导 |
| D8 | 错误模型 | 契约级六分类 `error.kind` | GLM 实测的 authError/noPlan/emptyCtx 推广为通用语义；自检可结构化呈现 | 各适配器自定义错误字符串 |
| D9 | 消息协议 | 随扩展版本**同进同退**，不做版本协商 | 三个 UI 端与后台打同一个 CRX 发布，无远端依赖 | 消息版本协商（不必要） |
| D10 | 本期服务商 | 仅 GLM；契约验证用双 GLM 连接 + fixtures 回归 | 见文首范围声明 | 本期即接入 codex/claude |

---

## 2. 目标架构总览

```
┌──────────────────────────────────────────────────────────────┐
│ Background Service Worker                                     │
│                                                               │
│  service-worker.js   生命周期 · 消息路由 · 侧边栏手势逻辑       │
│       ├── orchestrator.js   1min tick → 到期过滤 → 并行同步     │
│       └── connections.js    连接 CRUD（先验证后落盘）· 迁移     │
│                                                               │
│  Provider Registry（静态注册）                                 │
│       └── providers/glm.js   协议 + 凭据 + 归一化（唯此一处）   │
└──────┬───────────────────────────────┬───────────────────────┘
       │ conn:<id> / snap:<id> 分键    │ 消息总线 quorb/*
       ▼                               ▼
┌────────────────────┐    ┌────────────────────────────────────┐
│ chrome.storage     │◄───┤ UI 层（三端全部是哑渲染器）           │
│  conn:<id> 配置+状态│ 监 │ content:  main / bridge / orb /    │
│  snap:<id> 快照    │ 听 │           panel（esbuild 打包）      │
│  meta / ui         │    │ sidepanel: 多连接完整面板            │
└────────────────────┘    │ options:   连接管理 + 逐连接自检     │
                          └───────────────┬────────────────────┘
                                          │ import
                              src/shared/ 共享层
                              aggregate.js · format.js · icons.js
                              （聚合语义 / 文案格式化 全局唯一实现）
```

一句话原则：**服务商知识只在 `providers/`；聚合语义只在 `shared/aggregate.js`；
UI 端零协议知识、只做渲染。**

---

## 3. Provider 契约

每个适配器导出一个描述符。向导（渲染表单）、编排器（同步）、设置页（自检/调试）
都由描述符数据驱动，适配器之间互不感知。

```js
// src/providers/glm.js（参考实现）
export default {
  id: 'glm',                        // 稳定标识，进存储；一经发布不可变更
  label: 'GLM Coding Plan',
  icon: 'glm',                      // shared/icons.js 中 PROVIDER_ICONS 的 key
  authMode: 'manual',               // 'manual' | 'session'

  configSchema: {
    fields: [
      { name: 'region', type: 'segment', label: '区域',
        default: 'bigmodel',
        options: [
          { value: 'bigmodel', label: 'bigmodel.cn（大陆）' },
          { value: 'zai',     label: 'z.ai（国际，实验性）' },
        ] },
      { name: 'apiKey', type: 'password', label: 'API Key',
        required: true,
        validate: v => v.trim().length >= 8,
        hint: '个人版 / 团队版均在对应 Coding Plan 套餐页获取；保存前会先验证' },
      { name: 'organization', type: 'text', label: '组织 ID',
        placeholder: 'org-…', hint: '仅团队套餐填写，个人账号留空' },
      { name: 'project', type: 'text', label: '项目 ID',
        placeholder: 'proj_…', hint: '仅团队套餐填写，个人账号留空' },
    ],
  },

  consoleUrl: cfg => cfg.region === 'zai'
    ? 'https://z.ai/manage-apikey/apikey-list'
    : 'https://bigmodel.cn/coding-plan',

  /** 唯一的运行时入口：拉取并归一化用量。
   *  成功：{ ok: true, snapshot: { plan?, windows[], endpoint, raw } }
   *  失败：{ ok: false, error: { kind, message, attempts? } }
   *  依赖一律注入（fetchImpl），保证 node --test 可测。 */
  async fetchUsage(config, { fetchImpl, now = Date.now }) { … },

  // —— session 模式专用（可选导出，本期 GLM 不实现）——
  // captureSession({ openTab, probe }) → config 片段
}
```

### 3.1 表单字段描述符

| 属性 | 必填 | 说明 |
|------|------|------|
| `name` | ✓ | 对应 `conn.config.<name>` |
| `type` | ✓ | `password` / `text` / `segment`（本期三种，够 GLM 用） |
| `label` `placeholder` `hint` `default` | | 向导渲染所需的全套文案；**凭据获取指引写在 hint 里**（GLM 的 DevTools 抓 org/project 教程即此处） |
| `required` `validate(v)` | | 向导据此控制保存按钮可用性 |
| `options` | segment 必填 | `[{ value, label }]` |

### 3.2 归一化窗口结构（不变）

```
{ id, label, kind: 'rolling' | 'fixed', used, limit, left, pct, unit, resetAt }
```

这是 v0.4 UI 已依赖的稳定结构，全部服务商沿用。GLM 实测语义
（`percentage` 是「已用」的 0–100 整数，不是 0–1 比例）由 glm.js 内部消化，不外泄。

### 3.3 错误分类

| kind | 语义 | GLM 现有映射 | 用户可见提示方向 |
|------|------|--------------|------------------|
| `auth` | 凭据失效 | HTTP 401/403 | 重新填写 Key / 重新登录 |
| `noPlan` | 账号无生效套餐 | 「当前用户不存在coding plan」 | 先订阅或改填团队上下文 |
| `context` | 上下文不匹配 | `data:{}` 空对象 | 核对 org/project（区分大小写） |
| `network` | 网络失败 | fetch 抛错 | 稍后重试 / 检查代理 |
| `parse` | 响应解析失败 | JSON.parse 失败 | 接口可能变更，看调试原始返回 |
| `unknown` | 其它 | — | 附 attempts 明细 |

`attempts`（GLM 的个人不带 type / type=1 / type=2 探测轨迹）原样保留进 `error`，供设置页调试展示。

---

## 4. 存储模型 v2 与迁移

### 4.1 键族

```
meta        = { schemaVersion: 2 }
conn:<id>   = { id, provider, label, enabled,
                config: {…provider 自有结构…},
                pollMinutes, lastSyncAt,
                status: { state: 'ok'|'syncing'|'auth'|'error', message, ts } }
snap:<id>   = { ts, gen, endpoint, plan, windows[], raw }
ui          = { orbScope: 'all' | '<connId>', pos, docked,
                hiddenOrigins: [], order: [<connId>…] }
```

要点：

- `id` 由 SW 生成（`'c_' + crypto.randomUUID().slice(0, 8)`），创建后不可变。
- `label` 用户可编辑，默认取 provider label（如「GLM Coding Plan」），多连接时靠它区分「个人 / 团队」。
- `status` 内嵌在 conn 里（单连接时代是全局键，多连接后状态天然属于连接）。
  `stale` **不是存储态**，由聚合层按 `ts` 推导（见第 6 节）。
- `snap.gen`（写快照时的扩展版本）保留，新旧脚本混跑提示逻辑不变，只是按 `snap:<id>` 生效。
- 凭据永远只在 `conn.config` 里；`snap.raw` 是接口原始响应，不含凭据。

### 4.2 迁移（v1 → v2）

`src/lib/migrate.js` 导出纯函数，输入 v1 三键的值，输出应写入的键值与新建连接 id，
node --test 直接可测；SW 侧 `onInstalled` 调用落盘：

```
planMigration({ cfg, snap, status }) → { writes: { conn:c_x, snap:c_x, ui, meta }, connId }
```

规则：

- 旧 `cfg.apiKey` 存在 → 建一条 glm 连接：config 取 region/apiKey/organization/project，
  pollMinutes 沿用；旧 `snap` → `snap:<id>`；旧 `cfg.pos/docked/hiddenOrigins` → `ui`。
- 旧 `cfg` 存在但无 apiKey → 不建连接，仅写 `meta.schemaVersion=2`（干净空态）。
- 无 cfg 的孤儿 snap 直接丢弃。
- **旧键（cfg/snap/status）原样保留一个版本**（0.5 保留，0.6 清理），升级出问题可回滚到 0.4。

---

## 5. 同步编排（orchestrator.js）

```
alarm tick（1 分钟，全局唯一）
  → listConnections()
  → due = enabled && now - lastSyncAt >= pollMinutes × 60_000
  → Promise.allSettled(due.map(syncConnection))

syncConnection(conn):
  conn.status = 'syncing'（落盘）
  provider.fetchUsage(conn.config)     // registry 查表；依赖注入便于测试
  ├─ ok   → set('snap:<id>')，status='ok'，lastSyncAt=now
  └─ fail → status = error.kind === 'auth' ? 'auth' : 'error'，message 落盘
  任何异常只影响本连接（allSettled + 内层 try/catch 双保险）
```

- alarm 晚到（系统休眠）无害：到期判断基于 `lastSyncAt`，tick 一到就补跑。
- `onInstalled` / `onStartup` / 面板手动刷新走同一 `syncDue()` 入口。
- 单一连接的轮询周期在 1 分钟粒度上取整（`pollMinutes >= 1`），与现状一致。

---

## 6. 聚合层（shared/aggregate.js）

三个 UI 端对「最紧窗口」的理解必须来自同一个函数，这是消灭三处重复渲染逻辑的关键：

```
aggregate(entries /* [{ conn, snapshot? }] */, { now }) → {
  globalPct,                          // 参与连接的最紧窗口 pct 的 min；无参与连接为 null
  binding: { connId, providerId, window },
  connections: [{ …conn, windows, stale, isBinding, excluded, excludedWhy }],
}
```

参与 / 排除规则（按序判定）：

1. `enabled === false` → 排除（面板灰显，不进全局 min）。
2. `status.state ∈ {auth, error}` → 排除（卡片亮错误态）。
3. 快照缺失 → 排除（显示「等待首次同步」）。
4. **过期**：`now - snapshot.ts > max(2 × pollMinutes, 15min)` → 排除并标 `stale`
   （「数据过期」——失联连接不得用旧数据假装健康，也不能拖垮全局数字）。
5. 其余参与；`pct` 取该连接所有窗口的 min；全局再取参与连接的 min。

`ui.orbScope`：`'all'`（默认，球体显示 globalPct）或某连接 id（球体只盯它）。

---

## 7. UI 层与消息总线

### 7.1 content script 拆分

602 行单体拆成四个模块，共享一个由 main.js 创建并注入的 context（state + DOM 引用）：

| 模块 | 职责（对应现有代码段） |
|------|------------------------|
| `main.js` | 入口守卫（iframe / 已挂载 / chrome:// / #quorb-hide）、Shadow Root 创建、mount 生命周期、resize / visibilitychange、启动序列 |
| `bridge.js` | `send()`、`storage.onChanged` 订阅、`state.data` 拉取与缓存 |
| `orb.js` | 亮度探测、球体 SVG、悬浮提示、拖拽 / 磁吸 / 停靠全套物理（clampPos → wireOrb） |
| `panel.js` | 面板视图（主视图 / 声明式向导 / 连接管理）与事件绑定 |

### 7.2 消息总线 v2

| 消息 | 请求 → 响应 | 说明 |
|------|-------------|------|
| `quorb/get` | → `{ connections[], aggregate, ui, providers[] }` | providers 为注册表摘要，供向导列服务商 |
| `quorb/conn:save` | `{ id?, provider, label?, config }` → `{ ok, windows?, plan? }` | **先 fetchUsage 验证，通过才落盘**（沿用现语义） |
| `quorb/conn:delete` | `{ id }` | 同时清 `conn:` 与 `snap:` 两键 |
| `quorb/conn:toggle` | `{ id, enabled? }` | 启停，不删数据 |
| `quorb/conn:setPoll` | `{ id, minutes }` | 替代 `quorb/setPoll` |
| `quorb/conn:refresh` | `{ id? }`（缺省全部） | 替代 `quorb/refresh` |
| `quorb/ui:save` | `{ pos?, docked?, order?, orbScope? }` | 替代 `quorb/savePos` 并扩展 |
| `quorb/toggleOrigin` `quorb/diagnose` `quorb/openSidePanel` `quorb/toggleSidePanel` `quorb/openOptions` `quorb/openConnect` `quorb/openConsole` | | 保留；diagnose 升级为逐连接输出 |

P1 期间 `quorb/get` 额外投影一份旧字段（`snapshot`/`status`/`pollMinutes` 等，
取绑定连接），让未改造的旧 UI 继续工作，保证每个阶段可独立发布；P2 收尾删除投影。

### 7.3 向导与面板

- 向导不再含任何 GLM 字面量：字段、校验、提示全部来自 `configSchema`。
  服务商选择来自 `providers[]`（本期只有 glm 一项，UI 已按多服务商渲染）。
- 面板主视图 = 聚合 Hero（globalPct + binding 标注来源连接）+ 每连接一张卡
  （provider 图标、label、窗口列表、状态、重置倒计时），沿用现有最紧描边视觉。
- `authMode: 'session'` 的分支（「打开控制台登录」按钮 → captureSession）本期只留接口，
  不实现——向导按 authMode 分支渲染的骨架在 P2 就位。

---

## 8. 安全红线（逐条保持，连接变多后泄露面变大）

1. 凭据仅存 `chrome.storage.local`，绝不使用 `storage.sync` / 云备份。
2. 凭据**从不进入内容脚本**（消息响应中 config 永不回传明文 Key；打码可以）。
3. 请求只发往所选服务商的官方域名（GLM：open.bigmodel.cn / api.z.ai）。
4. 界面任何位置 Key 打码显示；调试「原始返回」展示 `snap.raw`（不含凭据）。
5. `web_accessible_resources` 最小化：保留 `src/content/ui.css`，移除不再需要的 `src/lib/*`。
6. 自检（diagnose）新增一项审计：列出所有连接的凭据存储位置断言（应为 local + 非 sync）。
7. 未来服务商域名走 `optional_host_permissions`，连接保存时按需 `chrome.permissions.request`
   ——不用某服务商就不授权其域名，缩小审核面。GLM 域名本期保持必选不变。

---

## 9. 测试策略

| 层 | 载体 | 覆盖 |
|----|------|------|
| 纯逻辑单元 | `node --test test/unit/`（CI 可跑，无浏览器依赖） | providers（注入 fetchImpl + fixtures）、aggregate 排除规则、format、migrate 边界、orchestrator（注入假 registry / 假时钟） |
| fixtures | `test/fixtures/*.json` | GLM 个人 TOKENS_LIMIT 双窗 / 个人无套餐 / 团队 CREDIT_LIMIT 双窗 / `data:{}` 空上下文 / 401，全部脱敏样本 |
| 浏览器断言 | `test/harness.html` | 解析与聚合断言、向导 schema 渲染 |
| UI 预览 | `test/page.html` + `mock-chrome.js` | 无需装扩展预览球体与面板；mock fixtures 升级为双连接 |
| 真机 E2E | 人工清单 | 双 GLM 连接（个人 + 团队三要素）× 24h：独立同步、错误互不传染、聚合正确、旧数据迁移无感 |

`npm run check`（语法 + 构建）、`npm test`（单元）、harness（手动）三层门禁。

---

## 10. 文件级任务拆解

目标文件树（★ = 本期新增，✎ = 修改，✕ = 删除）：

```
quorb/
├── manifest.json                  ✎
├── package.json                   ✎   scripts: build/check/test；devDeps: esbuild
├── build.mjs                      ★   esbuild：content 单入口打包
├── docs/architecture.md           ★   本文档
├── src/
│   ├── providers/
│   │   ├── registry.js            ★
│   │   └── glm.js                 ★   ← src/lib/glm.js 改名 + 契约化
│   ├── shared/
│   │   ├── format.js              ★   ← 抽自 content/index.js + sidepanel/panel.js
│   │   ├── icons.js               ★   ← ICONS 迁入 + PROVIDER_ICONS
│   │   └── aggregate.js           ★
│   ├── background/
│   │   ├── service-worker.js      ✎   改薄：路由 + 生命周期
│   │   ├── orchestrator.js        ★
│   │   └── connections.js         ★
│   ├── content/
│   │   ├── main.js                ★   ← 拆分自 index.js
│   │   ├── bridge.js              ★   ← 拆分自 index.js
│   │   ├── orb.js                 ★   ← 拆分自 index.js
│   │   ├── panel.js               ★   ← 拆分自 index.js
│   │   ├── ui.css                 ✎
│   │   └── index.js               ✕   （由 dist/ 构建产物取代）
│   ├── lib/
│   │   ├── store.js               ✎   v2 键族
│   │   ├── migrate.js             ★
│   │   └── glm.js                 ✕
│   ├── sidepanel/panel.{html,js}  ✎
│   └── options/options.{html,js}  ✎
├── test/
│   ├── unit/                      ★   glm / aggregate / format / migrate / orchestrator / contract
│   ├── fixtures/                  ★   脱敏响应样本
│   ├── mock-chrome.js             ✎   双连接 fixtures
│   └── harness.html, page.html …  ✎
└── dist/                          ★   构建产物（dist/content/index.js；不入版本库）
```

### P0 · 地基（纯重构，零行为变化）→ v0.4.1

| 文件 | 动作 | 内容 |
|------|------|------|
| `package.json` | ✎ | devDeps 加 esbuild（锁定版本）；scripts：`build`（node build.mjs）、`check`（语法 + build）、`test`（node --test test/unit/） |
| `build.mjs` | ★ | esbuild：`src/content/main.js` → `dist/content/index.js`（iife、不压缩保持可审查） |
| `manifest.json` | ✎ | content_scripts 与 SW `injectIntoExistingTabs` 的 files 改指 `dist/content/index.js`；WAR 移除 `src/lib/*` |
| `src/shared/format.js` | ★ | `fmt` `fmtSyncTime` `resetText` `bindingPct` `bindingWin` `thresholdCls`（阈值色判定）——从 content 与 sidepanel 双份实现合一 |
| `src/shared/icons.js` | ★ | 现 ICONS 对象迁入；预留 `PROVIDER_ICONS` 映射（本期只有 glm） |
| `src/content/main.js` | ★ | 入口守卫、Shadow Root、mount 生命周期、resize/visibility、启动序列（保留「节点创建前不碰 DOM」教训） |
| `src/content/bridge.js` | ★ | `send()`、onChanged 订阅、state.data 拉取 |
| `src/content/orb.js` | ★ | 球体渲染、提示气泡、拖拽磁吸停靠全套 |
| `src/content/panel.js` | ★ | 面板视图与事件（本阶段仍是单连接 GLM 形态，仅搬移） |
| `src/content/index.js` | ✕ | 源文件删除，产物接管 |
| `src/sidepanel/panel.js` | ✎ | 改 import shared/format；**清理 `document.title += '|Pn'` 调试残留** |
| `src/options/options.js` | ✎ | 同上引 shared/format |
| `test/unit/format.test.js` | ★ | resetText 滚动/固定窗口、阈值边界（20/45） |
| `test/harness.html` `test/page.html` `test/mock-chrome.js` | ✎ | 适配产物路径 |

**验收**：浏览器加载构建产物后，悬浮球 / 面板 / 磁吸 / 深色 / #quorb-open / #quorb-hide 与拆分前一致；harness PASS；`npm run build && npm run check && npm test` 全绿。

### P1 · 数据面（契约 + 存储 v2 + 编排 + 迁移）→ v0.5.0

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/providers/glm.js` | ★ | 现 glm.js 改名并套上第 3 节契约：REGIONS 内聚成 configSchema 选项；`fetchRawUsage`+`normalizeUsage` 组合为 `fetchUsage`（内部函数保留独立导出供测试）；错误映射为 `error.kind` |
| `src/providers/registry.js` | ★ | `export const REGISTRY = { glm: glmProvider }`；`listProviders()` 摘要（id/label/icon/authMode/configSchema） |
| `src/lib/glm.js` | ✕ | 移入 providers |
| `src/lib/store.js` | ✎ | v2 键族助手：`getMeta/setMeta`、`listConnections`（扫描 `conn:*`）、`get/set/delConnection`、`get/setSnap`、`get/setUi` |
| `src/lib/migrate.js` | ★ | `planMigration` 纯函数（第 4.2 节规则），SW 侧落盘 |
| `src/shared/aggregate.js` | ★ | 第 6 节聚合与排除规则 |
| `src/background/orchestrator.js` | ★ | tick / syncDue / syncConnection / syncAll；registry 与 fetchImpl 注入可测 |
| `src/background/connections.js` | ★ | conn:save（先验证后落盘）/ delete / toggle / setPoll / diagnose 组装 |
| `src/background/service-worker.js` | ✎ | 改薄：生命周期、1min alarm、消息路由到 connections/orchestrator、迁移触发；**sidePanel 手势逻辑原样保留（open 前 zero-await 约束不变）**；`quorb/get` 同时返回新结构与旧字段投影 |
| `test/unit/glm.test.js` | ★ | fixtures 四态：双窗归一 / percentage 整数语义 / noPlan / context / auth |
| `test/unit/aggregate.test.js` | ★ | 排除规则 1–5、跨连接最紧、stale 判定边界 |
| `test/unit/migrate.test.js` | ★ | 有 Key / 无 Key / 孤儿 snap 三分支 |
| `test/unit/orchestrator.test.js` | ★ | 到期过滤、错误隔离（A 连接 auth 不影响 B）、假时钟 |
| `test/fixtures/glm-*.json` | ★ | 脱敏样本四份 |

**验收**：v0.4 旧存储升级后 UI 显示不变（迁移无感，旧键仍在）；手工造两条连接可各自独立轮询、错误互不传染；`npm test` 全绿。

### P2 · UI 面（多连接 + 声明式向导）→ v0.6.0

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/content/panel.js` | ✎ | 向导改 configSchema 驱动（字段渲染 / 校验 / hint 全来自描述符，authMode 分支骨架就位）；主视图 = 聚合 Hero + 连接卡片；新增管理子视图（启停 / 改名 / 删除 / 排序） |
| `src/content/orb.js` `src/content/main.js` | ✎ | `currentPct` 改走 aggregate；orbScope 支持 |
| `src/content/ui.css` | ✎ | 连接卡片、provider 徽标、管理视图样式（沿用液态玻璃体系） |
| `src/sidepanel/panel.html` `panel.js` | ✎ | 多连接卡片渲染（走 aggregate），管理入口 |
| `src/options/options.html` `options.js` | ✎ | 单 Key 表单 → 连接列表管理页；原始返回改「按连接下拉选择」；自检逐连接输出 |
| `src/background/service-worker.js` `connections.js` | ✎ | `quorb/get` 删除旧字段投影；新增 `ui:save`；删除 saveKey/clearKey/setPoll/savePos 旧消息 |
| `test/mock-chrome.js` | ✎ | fixtures 升级双连接（个人 + 团队），覆盖 stale 态 |
| `test/harness.html` | ✎ | 聚合断言：跨连接取最紧、排除规则 |

**验收**：向导与面板源码 grep 不到 glm/bigmodel 字面量（全部来自 schema/registry）；个人 + 团队双 GLM 连接实测正确；删除连接后 conn/snap 两键都清理。

### P3 · 契约验证与收尾（GLM-only 铺开）→ v0.7.0

| 文件 | 动作 | 内容 |
|------|------|------|
| `test/unit/contract.test.js` | ★ | 遍历 registry：描述符形状断言（id/label/icon/authMode/configSchema/fetchUsage）；对每个 provider 用 fixtures 跑归一化回归 |
| `test/harness.html` `test/page.html` | ✎ | 多连接预览场景 |
| `README.md` | ✎ | 目录段更新、链接本文档、双连接用法 |
| `docs/best-practices.md` | ✎ | 增补拆分与构建期新踩坑（如有） |
| `manifest.json` | ✎ | 版本 0.7.0 |

**验收（本期最终目标）**：真机双 GLM 连接（个人不带 type + 团队三要素 type=2）连续运行 24h——
独立同步、错误隔离、聚合正确、位置与隐藏站点记忆正常；
**从「新增一条连接」到「球体正确聚合」全程没有改过 UI 与后台代码**——这就是第 11 节未来适配器的验收预演。

---

## 11. 未来：新增服务商指南（codex / claude / 火山引擎）

按 checklist 执行，**不触碰 UI 与后台**：

1. `src/providers/<id>.js`：实现第 3 节契约——configSchema（凭据获取指引写进 hint）、
   `fetchUsage`（探测顺序与错误映射按 GLM 的模式）、windows 归一化。
   session 类（如 Claude 订阅用量）实现 `captureSession` 钩子。
2. `src/providers/registry.js`：注册一行。
3. `src/shared/icons.js`：`PROVIDER_ICONS['<id>']` 加内联 SVG。
4. `manifest.json`：域名进 `optional_host_permissions`，连接保存时按需申请（第 8.7 条）。
5. `test/fixtures/<id>-*.json` + `test/unit/<id>.test.js`：脱敏样本回归。
6. `README.md`：服务商段落与获取凭据指引。

禁止事项：在 providers/ 之外出现协议知识或 provider 分支判断；把凭据传进内容脚本；
为单个服务商改动 aggregate 语义（口径变化应作为全局决策演进并更新本文档）。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 各家用量接口非公开（GLM 已验证此风险真实存在） | 接口随时变更 | 契约隔离 + `error.kind` 分类 + snap.raw 调试回显（按连接），用户可自救、可快速定位 |
| host 权限随服务商增长，商店审核收紧 | 上架受阻 | optional_host_permissions 按需授权（第 8.7 条） |
| 连接变多后凭据泄露面变大 | 安全事故 | 第 8 节红线逐条保持 + 自检新增存储位置审计 |
| esbuild 供应链 | 构建被投毒 | 锁定版本；产物不压缩保持可 diff、可审查 |
| MV3 alarm 被系统延迟 | 同步滞后 | 到期过滤基于 lastSyncAt，tick 晚到即补跑（第 5 节） |
| 多连接同步写放大触发 onChanged 风暴 | UI 抖动 | 分键天然细粒度；bridge 侧已有 150ms 合并刷新（沿用） |
| SW 手势约束（sidePanel.open）回归 | 点击无响应 | P1 明确该逻辑原样搬移，open 前零 await 的约束写入代码注释与 best-practices |

---

## 13. 项目结构（当前）

```
manifest.json              MV3 清单
build.mjs                  esbuild 构建入口（content script 单入口打包 → dist/content/index.js）
src/providers/             服务商适配层：registry（注册表）+ glm.js（协议/凭据/归一化唯一实现）
src/shared/                三端共享层：aggregate（聚合/排除规则唯一实现）· format（文案口径）· icons
src/background/            service-worker（生命周期/消息路由/侧边栏手势）· orchestrator（1min tick 编排）
                           · connections（连接 CRUD 先验证后落盘 · v1→v2 迁移与旧键清理 · 自检）
src/lib/                   store.js（chrome.storage.local 封装，v2 键族 conn:/snap:/ui/meta）· migrate.js
src/content/               内容脚本：main/bridge/orb/panel（Shadow DOM 球体 + 面板 + 声明式向导；ui.css 液态玻璃）
src/sidepanel/             侧边栏完整面板（多连接卡片，走 aggregate 口径）
src/options/               设置页：连接列表管理（声明式表单）、逐连接自检与调试
test/unit/                 node --test：glm / aggregate / format / migrate / orchestrator / connections / contract
test/fixtures/             脱敏响应样本（双窗 / 无套餐 / 空上下文）
test/                      harness（解析+聚合+schema 断言）· mock-chrome（双连接桩）· page/sidepanel 预览页
docs/architecture.md       多服务商架构规划（决策记录 / 契约 / 任务拆解 / 新增服务商指南）
docs/glm-usage-api.md     GLM 用量接口实测参考（调用方式 / 响应语义 / 团队席位三要素）
```
