/* quorb · 测试用 chrome.* 桩：在普通页面里驱动内容脚本 / 侧边栏 / 设置页（仅 test/ 使用）
 * P2：v2 消息总线 + 双连接 fixtures（个人 + 团队），另附一条过期连接覆盖 stale 排除态。
 * 动作类消息会真实修改内存状态并触发 storage.onChanged 监听器，UI 可交互预览。 */
(function () {
  const NOW = Date.now();
  const win = (id, label, kind, used, limit, left, pct, resetAt) =>
    ({ id, label, kind, used, limit, left, pct, unit: '积分', resetAt });

  const CONNS = [
    {
      id: 'c_personal', provider: 'glm', label: '个人版', enabled: true, pollMinutes: 5,
      safeConfig: { region: 'bigmodel', apiKey: '••••••••', organization: '', project: '' },
      status: { state: 'ok', message: '', ts: NOW - 60e3 }, plan: 'GLM Coding · max', gen: '0.7.0-mock',
      windows: [
        win('h5', '5 小时窗口', 'rolling', 12400, 35000, 22600, 35, NOW + 1.2e6),
        win('week', '本周', 'fixed', 58800, 155000, 96200, 38, NOW + 2.6e8),
      ],
    },
    {
      id: 'c_team', provider: 'glm', label: '团队席位', enabled: true, pollMinutes: 5,
      safeConfig: { region: 'bigmodel', apiKey: '••••••••', organization: 'org-demo', project: 'proj_demo' },
      status: { state: 'ok', message: '', ts: NOW - 90e3 }, plan: 'GLM Coding · team', gen: '0.7.0-mock',
      windows: [
        win('h5', '5 小时窗口', 'rolling', 28000, 35000, 7000, 20, NOW + 0.9e6),
        win('week', '本周', 'fixed', 74400, 155000, 80600, 52, NOW + 2.6e8),
      ],
    },
    {
      id: 'c_stale', provider: 'glm', label: '旧团队（演示过期）', enabled: true, pollMinutes: 5,
      safeConfig: { region: 'bigmodel', apiKey: '••••••••', organization: 'org-old', project: 'proj_old' },
      status: { state: 'ok', message: '', ts: NOW - 30 * 60e3 }, plan: 'GLM Coding · team', gen: '0.6.0-mock',
      windows: [win('h5', '5 小时窗口', 'rolling', 33950, 35000, 1050, 3, NOW + 0.5e6)],
    },
  ];

  /* 与 providers/registry.js 的 listProviders() 摘要同构（可 JSON 序列化） */
  const PROVIDERS = [{
    id: 'glm', label: 'GLM Coding Plan', icon: 'glm', authMode: 'manual',
    configSchema: {
      fields: [
        {
          name: 'region', type: 'segment', label: '区域', default: 'bigmodel',
          options: [
            { value: 'bigmodel', label: 'bigmodel.cn（大陆）', consoleUrl: 'https://bigmodel.cn/coding-plan' },
            { value: 'zai', label: 'z.ai（国际，实验性）', consoleUrl: 'https://z.ai/manage-apikey/apikey-list' },
          ],
        },
        { name: 'apiKey', type: 'password', label: 'API Key', required: true, minLength: 8, hint: '保存前会先验证；仅保存在本机' },
        { name: 'organization', type: 'text', label: '组织 ID', placeholder: 'org-…', hint: '团队席位必填，个人留空' },
        { name: 'project', type: 'text', label: '项目 ID', placeholder: 'proj_…', hint: '团队席位必填，个人留空' },
      ],
    },
  }];

  const UI = { orbScope: 'all', pos: null, docked: null, hiddenOrigins: [], order: CONNS.map(c => c.id) };
  const listeners = new Set();
  const fire = key => {
    const changes = {};
    changes[key] = { newValue: null };
    listeners.forEach(l => { try { l(changes, 'local'); } catch {} });
  };

  const staleThreshold = c => Math.max(2 * (c.pollMinutes || 5), 15) * 60e3;
  function buildGet() {
    const t = Date.now();
    const conns = CONNS.map(c => {
      let excluded = null;
      if (c.enabled === false) excluded = 'disabled';
      else if (c.status.state === 'auth' || c.status.state === 'error') excluded = c.status.state;
      else if (!c.status.ts) excluded = 'nosnap';
      else if (t - c.status.ts > staleThreshold(c)) excluded = 'stale';
      const pcts = c.windows.map(w => w.pct).filter(v => typeof v === 'number');
      return {
        ...c, ts: c.status.ts, stale: excluded === 'stale', excluded,
        pct: pcts.length ? Math.min(...pcts) : null,
      };
    });
    const parts = conns.filter(c => !c.excluded && typeof c.pct === 'number');
    let binding = null;
    if (parts.length) {
      const b = parts.reduce((m, c) => (c.pct < m.pct ? c : m), parts[0]);
      binding = {
        connId: b.id, providerId: b.provider, pct: b.pct,
        window: b.windows.slice().sort((a, b2) => (a.pct ?? 100) - (b2.pct ?? 100))[0] || null,
      };
    }
    return {
      ok: true, schemaVersion: 2,
      connections: conns,
      aggregate: { globalPct: binding ? binding.pct : null, binding },
      ui: { ...UI },
      providers: PROVIDERS,
    };
  }

  function saveConn(msg) {
    const values = msg.config || {};
    const existing = msg.id ? CONNS.find(c => c.id === msg.id) : null;
    const now = Date.now();
    const windows = existing
      ? existing.windows
      : [win('h5', '5 小时窗口', 'rolling', 10000, 35000, 25000, 71, now + 1.5e6), win('week', '本周', 'fixed', 50000, 155000, 105000, 68, now + 2.6e8)];
    const safeConfig = {};
    for (const f of PROVIDERS[0].configSchema.fields) {
      safeConfig[f.name] = f.type === 'password' ? '••••••••' : (values[f.name] ?? '');
    }
    if (existing) {
      Object.assign(existing, { label: msg.label || existing.label, safeConfig, status: { state: 'ok', message: '', ts: now } });
      fire('conn:' + existing.id);
      return { ok: true, id: existing.id, windows, plan: existing.plan };
    }
    const id = 'c_' + Math.random().toString(36).slice(2, 8);
    CONNS.push({
      id, provider: msg.provider || 'glm', label: msg.label || '新连接', enabled: true, pollMinutes: 5,
      safeConfig, status: { state: 'ok', message: '', ts: now }, plan: 'GLM Coding · max', gen: '0.7.0-mock', windows,
    });
    UI.order.push(id);
    fire('conn:' + id);
    return { ok: true, id, windows, plan: 'GLM Coding · max' };
  }

  window.chrome = {
    runtime: {
      getURL: p => new URL('/' + p.replace(/^\/+/, ''), location.origin).href,
      lastError: null,
      getManifest: () => ({ version: '0.7.0-mock' }),
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: (msg, cb) => {
        try {
          if (msg?.type === 'quorb/get') cb(buildGet());
          else if (msg?.type === 'quorb/conn:save') cb(saveConn(msg));
          else if (msg?.type === 'quorb/conn:delete') {
            const i = CONNS.findIndex(c => c.id === msg.id);
            if (i >= 0) { CONNS.splice(i, 1); UI.order = UI.order.filter(x => x !== msg.id); fire('conn:' + msg.id); }
            cb({ ok: true });
          } else if (msg?.type === 'quorb/conn:toggle') {
            const c = CONNS.find(x => x.id === msg.id);
            if (c) { c.enabled = msg.enabled ?? !c.enabled; fire('conn:' + c.id); }
            cb({ ok: true });
          } else if (msg?.type === 'quorb/conn:setPoll') {
            const c = CONNS.find(x => x.id === msg.id);
            if (c) { c.pollMinutes = msg.minutes; fire('conn:' + c.id); }
            cb({ ok: true });
          } else if (msg?.type === 'quorb/conn:refresh') {
            const now = Date.now();
            (msg.id ? CONNS.filter(c => c.id === msg.id) : CONNS).forEach(c => { c.status = { state: 'ok', message: '', ts: now }; fire('conn:' + c.id); });
            cb({ ok: true, synced: CONNS.length });
          } else if (msg?.type === 'quorb/ui:save') {
            for (const k of ['pos', 'docked', 'order', 'orbScope']) if (k in msg) UI[k] = msg[k];
            fire('ui');
            cb({ ok: true });
          } else if (msg?.type === 'quorb/snap:get') {
            const c = CONNS.find(x => x.id === msg.id);
            cb(c
              ? { ok: true, snap: { ts: c.status.ts, gen: c.gen, endpoint: 'mock://quota/limit?type=2', plan: c.plan, windows: c.windows, raw: { mock: true, level: 'max', limits: '（脱敏样例）' } } }
              : { ok: false, message: '该连接还没有快照' });
          } else if (msg?.type === 'quorb/toggleOrigin') {
            const list = new Set(UI.hiddenOrigins);
            list.has(msg.origin) ? list.delete(msg.origin) : list.add(msg.origin);
            UI.hiddenOrigins = [...list];
            fire('ui');
            cb({ ok: true, hidden: list.has(msg.origin) });
          } else cb({ ok: true });
        } catch (e) { cb({ ok: false, message: String(e && e.message) }); }
      },
      openOptionsPage: () => {},
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      create: () => {},
    },
    storage: {
      local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() },
      onChanged: {
        addListener: l => listeners.add(l),
        removeListener: l => listeners.delete(l),
      },
    },
  };
})();
