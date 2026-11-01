# GLM 用量接口 · 实测参考

quorb 使用的 GLM（智谱）用量接口未在官方文档公开。本文记录已通过真实账号**实测确认**的
调用方式、响应语义与团队席位配方。若官方调整接口：改 `src/providers/glm.js` 的
`fetchRawUsage` / `normalizeUsage` 即可，UI 不需要动；若官方给出公开接口请提 issue。

## 接口调用（个人 + 团队自动尝试）

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit?type={1|2}
authorization: <API key>              ← raw 形式，不加 Bearer 前缀
bigmodel-organization: org-…          ← 团队套餐必填
bigmodel-project:      proj-…         ← 团队套餐必填
accept: application/json
```

- `type=1` 个人套餐；`type=2` 团队套餐（quorb 自动按上下文依次尝试）
- 响应：`data.limits[]`，`type==='CREDIT_LIMIT'` 的条目为用量窗口：
  `unit:3` = 小时滚动窗（`number:5` → 5 小时）、`unit:6` = 周窗（`number:1` → 1 周）；
  `usage` 总量 / `currentValue` 已用 / `remaining` 剩余 / `percentage` 百分比 / `nextResetTime` 重置时间戳
- `data.level` 为套餐档位；重置卡在 `/api/biz/customer-package-reset/list?targetType=PERSONAL|TEAM`

错误语义（实测）：`当前用户不存在coding plan` → 个人版未订阅；`data:{}` → 团队上下文不匹配。

## 团队席位：手动填写三要素（实测确认，v0.1.7 起唯一方式）

**团队席位（Premium / Standard）的 5h / 周用量，用普通 API Key 读不到**（type=2 返回空 data），
实测可行的配方是三要素齐备：

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2
authorization: <团队编程套餐 Key>      ← raw 形式，不加 Bearer
bigmodel-organization: org-…           ← 组织 ID
bigmodel-project:      proj_…          ← 项目 ID
```

quorb 连接向导即为这三个输入框。获取方式：

1. **Key**：[团队编程套餐 → 我的套餐](https://bigmodel.cn/coding-plan?z_plan=team) 页面获取
   （与平台普通 API Key 相互独立）
2. **组织 ID / 项目 ID**：登录后打开团队用量页 → DevTools → Network → 刷新 →
   找 `quota/limit` 请求 → 复制 `bigmodel-organization` / `bigmodel-project` 两个请求头
   （区分大小写；org 后接 `-`、proj 后接 `_`）

## 团队版注意事项（实测确认）

- **团队套餐的用量必须同时携带** `bigmodel-organization`（org-…）与 `bigmodel-project`（proj-…）
  请求头；缺失或错误时返回空 `data:{}`，quorb 连接向导的「团队套餐」折叠区即用于填写二者
- `type=2`（团队）时带正确 org/project 即返回双窗数据；`type=1` 或不带 type 会返回
  「当前用户不存在coding plan」（个人套餐检查）。`open.bigmodel.cn` 与 `bigmodel.cn` 两域均可用
- **团队套餐 Key 与平台普通 API Key 相互独立**（官方 quick-start 明确说明），必须使用
  [团队编程套餐 → 我的套餐](https://bigmodel.cn/coding-plan?z_plan=team) 页面下发的 Key
- org/project **没有公开的自动发现接口**（社区工具 CodexBar / OmniRoute / pi-glm-quota /
  sub2api 全部要求手填）。获取方式：登录 → 打开团队用量页 → DevTools → Network →
  刷新 → 找 `quota/limit` 请求 → 复制两个请求头
