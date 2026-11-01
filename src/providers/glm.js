/* ============================================================
 * quorb · GLM Coding Plan 用量适配器（实测协议版）
 * 契约见 docs/architecture.md §3 —— 协议与凭据知识只允许出现在本文件。
 *
 * 已确认的调用方式（2026-11，个人 + 团队；个人形态依据真实账号返回）：
 *   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit[?type=2]
 *   authorization: <API key>            ← raw 形式；服务端也接受 Bearer 前缀
 *   个人套餐：不带 type 参数（type=1 作为兼容回退）
 *   团队套餐：type=2 + bigmodel-organization + bigmodel-project
 *
 * 响应：{ code, msg, success, data:{ level|planName, limits:[{
 *   type:'TOKENS_LIMIT'|'CREDIT_LIMIT', unit, number, usage(总量), currentValue(已用),
 *   remaining, percentage, nextResetTime }] } }
 *   unit 3 = 小时滚动窗口（number=5 → 5 小时）；unit 6 = 周窗口（number=1 → 1 周）
 *   个人套餐（老 V2 / 新版积分制）返回 TOKENS_LIMIT 或 CREDIT_LIMIT，团队套餐返回 CREDIT_LIMIT；
 *   TIME_LIMIT 是联网搜索等 MCP 的月度计数，不是套餐窗口，归一化时忽略。
 *
 * 错误语义（实测）：
 *   「当前用户不存在coding plan」→ 账号未订阅（个人 / 团队均可能）
 *   data:{}（空对象）           → 团队上下文不匹配（org/project 缺失或错误）
 * ============================================================ */

export const REGIONS = {
  bigmodel: {
    id: 'bigmodel',
    label: '智谱 bigmodel.cn（大陆）',
    quotaOrigin: 'https://open.bigmodel.cn',
    consoleUrl: 'https://bigmodel.cn/coding-plan',
  },
  zai: {
    id: 'zai',
    label: 'Z.ai（国际，实验性）',
    quotaOrigin: 'https://api.z.ai',
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
};

export function isZhipuPairKey(key) {
  return /^[0-9a-zA-Z]{8,}\.[0-9a-zA-Z_-]{8,}$/.test((key || '').trim());
}

/** 套餐窗口类型：个人版 TOKENS_LIMIT、团队 / 新版积分制 CREDIT_LIMIT。
 *  TIME_LIMIT（MCP 月度计数）与未知类型不算用量窗口。 */
function isUsageLimit(limit) {
  return limit?.type === 'TOKENS_LIMIT' || limit?.type === 'CREDIT_LIMIT';
}

/** 拉取原始用量（保留独立导出：单元测试 / harness 直测探测顺序）。
 *  个人套餐实测配方：raw key，不带 type（老接口 type=1 作为回退）；
 *  团队套餐实测配方：raw key + bigmodel-organization + bigmodel-project + type=2。 */
export async function fetchRawUsage({
  region = 'bigmodel', apiKey = '', organization = '', project = '', planType, fetchImpl = fetch,
} = {}) {
  const r = REGIONS[region] || REGIONS.bigmodel;
  const base = r.quotaOrigin + '/api/monitor/usage/quota/limit';
  const auth = (apiKey || '').trim();
  const attempts = [];

  const call = async (t) => {
    /* 个人套餐主路径不带 type；团队套餐才追加 type=2 */
    const url = t == null ? base : base + '?type=' + t;
    const headers = { accept: 'application/json' };
    if (auth) headers.authorization = auth;
    if (organization) headers['bigmodel-organization'] = organization;
    if (project) headers['bigmodel-project'] = project;
    try {
      const res = await fetchImpl(url, { headers, credentials: 'omit' });
      const text = await res.text();
      attempts.push({ url, status: res.status, type: t });
      if (res.status === 401 || res.status === 403) {
        return { fail: { ok: false, authError: true, status: res.status, attempts, message: '鉴权失败（401/403）：Key 可能已失效，请重新填写' } };
      }
      let json;
      try { json = JSON.parse(text); } catch { attempts.push({ url, parseError: true }); return null; }
      const limits = json?.data?.limits;
      if (json?.success && Array.isArray(limits) && limits.length > 0) {
        /* success 但只有 TIME_LIMIT / 未知条目时不算拿到套餐窗口，继续探测其它 type */
        if (limits.some(isUsageLimit)) {
          return { ok: true, endpoint: url, planType: t ?? null, json, attempts };
        }
        attempts.push({ url, type: t, noWindows: true, msg: json?.msg });
        return null;
      }
      attempts.push({ url, type: t, empty: !limits?.length, msg: json?.msg });
      return null;
    } catch (e) {
      attempts.push({ url, error: String(e && e.message || e) });
      return null;
    }
  };

  const hasCtx = !!(organization && project);
  /* 个人：先不带 type（主路径），再回退老个人 type=1、团队 type=2；
   * 团队：先 type=2，再回退 type=1（防止把个人 Key 误填了组织 / 项目）。 */
  const types = planType != null ? [planType] : hasCtx ? [2, 1] : [null, 1, 2];

  for (const t of types) {
    const r2 = await call(t);
    if (r2?.fail) return r2.fail;
    if (r2?.ok) return r2;
  }

  const noPlan = attempts.some(a => a.msg && /不存在coding plan/i.test(a.msg));
  const emptyCtx = attempts.some(a => a.empty);
  const noWindows = attempts.some(a => a.noWindows);
  return {
    ok: false,
    noPlan,
    emptyCtx,
    noWindows,
    attempts,
    message: noPlan
      ? '该账号未查询到生效中的 Coding Plan：个人版请先订阅；团队套餐请填写「组织 ID + 项目 ID」'
      : emptyCtx
        ? '已携带组织 / 项目上下文，仍未匹配到用量数据：请核对两个 ID 是否为 Coding Plan 所在团队（区分大小写）'
        : noWindows
          ? '接口有返回，但没有 5 小时 / 周用量窗口：请确认账号已订阅 Coding Plan（个人或团队）；若已订阅，可能是官方接口结构变更'
          : '未获取到用量数据（网络或接口变更）',
  };
}

/* ---------- 归一化为 UI 窗口结构（docs/architecture.md §3.2，跨服务商稳定） ---------- */
const UNIT_DEFS = {
  3: { kind: 'rolling', id: 'h5', label: n => n + ' 小时窗口' },
  6: { kind: 'fixed', id: 'week', label: n => (n === 1 ? '本周' : n + ' 周') },
};

export function normalizeUsage(json) {
  const limits = json?.data?.limits || [];
  /* level 是旧字段；新版个人套餐 / 其它区域可能用 planName / plan */
  const level = json?.data?.level || json?.data?.planName || json?.data?.plan;
  const windows = limits
    .filter(isUsageLimit)
    .map(l => {
      const u = UNIT_DEFS[l.unit] || {
        kind: 'fixed',
        id: 'u' + l.unit + 'x' + l.number,
        label: () => '窗口 u' + l.unit + '×' + l.number,
      };
      /* 实测语义：percentage 为「已用百分比」的整数（0–100，1 即表示已用 1%；
         切勿按 0–1 比例解释——整数 1 会被误判成已用 100%）。UI 展示「剩余百分比」。 */
      const usedPct = l.percentage != null
        ? l.percentage
        : (l.usage ? ((l.currentValue ?? 0) / l.usage) * 100 : 0);
      const pct = Math.max(0, Math.min(100, 100 - Math.round(usedPct)));
      return {
        id: u.id,
        label: u.label(l.number ?? 1),
        kind: u.kind,
        used: l.currentValue,
        limit: l.usage,
        left: l.remaining,
        pct,
        unit: '积分',
        resetAt: l.nextResetTime,
      };
    })
    .sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0));

  const binding = windows[0];
  return {
    plan: level ? 'GLM Coding · ' + level : undefined,
    level: level || undefined,
    windows,
    binding,
    raw: json,
  };
}

/* ---------- 契约实现（docs/architecture.md §3） ---------- */

/* 原始失败 → 契约错误六分类 */
function errorKind(raw) {
  if (raw.authError) return 'auth';
  if (raw.noPlan) return 'noPlan';
  if (raw.emptyCtx) return 'context';
  if (raw.noWindows) return 'parse';
  const a = raw.attempts || [];
  if (a.some(x => x.parseError)) return 'parse';
  if (a.some(x => x.error)) return 'network';
  return 'unknown';
}

const glm = {
  id: 'glm',
  label: 'GLM Coding Plan',
  icon: 'glm',
  authMode: 'manual',

  configSchema: {
    fields: [
      /* consoleUrl 挂在选项上：设置页「打开控制台」链接需要跨消息总线取到（函数不可序列化，
       * 顶层的 consoleUrl(cfg) 仅供 SW 侧使用）。minLength 同理：validate 函数过不了总线，
       * 向导侧用可序列化约束做同义校验（后台 validateConfig 两者都认）。 */
      { name: 'region', type: 'segment', label: '区域', default: 'bigmodel',
        options: [
          { value: 'bigmodel', label: 'bigmodel.cn（大陆）', consoleUrl: 'https://bigmodel.cn/coding-plan' },
          { value: 'zai', label: 'z.ai（国际，实验性）', consoleUrl: 'https://z.ai/manage-apikey/apikey-list' },
        ] },
      { name: 'apiKey', type: 'password', label: 'API Key', required: true,
        minLength: 8,
        validate: v => (v || '').trim().length >= 8,
        hint: '个人版 / 团队版均在对应 Coding Plan 套餐页获取（与平台普通 API Key 相互独立）；保存前会先验证' },
      { name: 'organization', type: 'text', label: '组织 ID', placeholder: 'org-…',
        hint: '仅团队套餐填写，个人账号留空（对应 bigmodel-organization 请求头）' },
      { name: 'project', type: 'text', label: '项目 ID', placeholder: 'proj_…',
        hint: '仅团队套餐填写，个人账号留空（对应 bigmodel-project 请求头）' },
    ],
  },

  consoleUrl(cfg = {}) {
    return (REGIONS[cfg.region] || REGIONS.bigmodel).consoleUrl;
  },

  /** 唯一运行时入口：拉取并归一化。依赖注入（fetchImpl/now）保证 node --test 可测。 */
  async fetchUsage(config = {}, { fetchImpl = fetch } = {}) {
    const raw = await fetchRawUsage({
      region: config.region,
      apiKey: config.apiKey,
      organization: config.organization,
      project: config.project,
      fetchImpl,
    });
    if (!raw.ok) {
      return { ok: false, error: { kind: errorKind(raw), message: raw.message || ('HTTP ' + (raw.status || '')), attempts: raw.attempts } };
    }
    const norm = normalizeUsage(raw.json);
    return { ok: true, snapshot: { plan: norm.plan, windows: norm.windows, endpoint: raw.endpoint, raw: raw.json } };
  },
};

export default glm;
