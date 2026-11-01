/* quorb · 面板 —— 主视图 / 连接管理 / 声明式向导 / 事件绑定
 * 服务商知识为零：字段、校验、提示全部来自 providers[]（quorb/get 下发的 configSchema 摘要）。
 * 密钥只在向导输入框短暂停留，从不持久化于内容脚本；编辑连接时凭据留空 = 保持已存值。
 * 口径：Hero 数字与来源标注走 shared/aggregate（displayStat 尊重 ui.orbScope）。 */
import { fmt, fmtSyncTime, resetText, thresholdCls } from '../shared/format.js';
import { ICONS, PROVIDER_ICONS } from '../shared/icons.js';
import { ORB, orbHTML, displayStat } from './orb.js';
import { send, reload, unmount, setLocalSync } from './bridge.js';

/* 用户可见字符串统一转义（连接 label 属用户输入） */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function placePanel(ctx) {
  const panel = ctx.panel;
  const pw = Math.min(348, innerWidth - 24);
  const ph = Math.min(560, innerHeight - 24);
  const orbCx = ctx.state.pos.x + ORB / 2;
  let x = orbCx > innerWidth / 2 ? ctx.state.pos.x - pw - 12 : ctx.state.pos.x + ORB + 12;
  x = Math.min(Math.max(x, 12), innerWidth - pw - 12);
  let y = ctx.state.pos.y + ORB + 12;
  if (y + ph > innerHeight - 12) y = ctx.state.pos.y - ph - 12;
  y = Math.min(Math.max(y, 12), innerHeight - ph - 12);
  panel.style.left = x + 'px';
  panel.style.top = y + 'px';
  panel.style.maxHeight = ph + 'px';
  const ox = ((ctx.state.pos.x + ORB / 2 - x) / pw * 100).toFixed(0);
  const oy = ((ctx.state.pos.y + ORB / 2 - y) / ph * 100).toFixed(0);
  panel.style.transformOrigin = `${ox}% ${oy}%`;
}

export function openPanel(ctx) { renderPanel(ctx); ctx.state.panelOpen = true; ctx.panel.classList.remove('closing'); }

export function closePanel(ctx) { if (!ctx.state.panelOpen || !ctx.panel) return; ctx.state.panelOpen = false; ctx.panel.classList.add('closing'); }

/* 从侧边栏 / 设置页跳转来的连接入口：已有连接进管理视图，没有连接直接进向导 */
export function openConnect(ctx) {
  const has = (ctx.state.data.connections || []).length > 0;
  if (has) ctx.state.subView = 'manage';
  else startWizard(ctx, null);
  openPanel(ctx);
}

/* ---------- 小部件 ---------- */
const pIcon = id => PROVIDER_ICONS[id] || ICONS.spark;
const anySyncing = ctx => ctx.state.localSync || (ctx.state.data.connections || []).some(c => c.status?.state === 'syncing');

function headHTML(ctx) {
  const { pct } = displayStat(ctx);
  return `<div class="qp-head">
    <span style="width:20px;height:20px;flex:none">${orbHTML({ pct: pct ?? 0, unset: pct == null, matDark: ctx.state.matDark, syncing: anySyncing(ctx) })}</span>
    <span class="name">quorb</span><span class="grow"></span>
    <button class="qp-iconbtn" data-act="options" title="设置">${ICONS.gear}</button>
    <button class="qp-iconbtn" data-act="close" title="关闭">${ICONS.close}</button>
  </div>`;
}

function secNote() {
  return `<div class="secnote"><div class="t">${ICONS.lock} 密钥的安全边界</div><ul>
    <li>仅保存在本机 chrome.storage.local，不使用 storage.sync</li>
    <li>不进入任何云备份；删除连接即销毁</li>
    <li>界面中永远打码，不明文回显</li>
    <li>用量请求只发往所选服务商的官方域名</li>
  </ul></div>`;
}

/* ---------- 主视图：聚合 Hero + 连接卡片 ---------- */
function heroHTML(ctx) {
  const d = ctx.state.data;
  const s = displayStat(ctx);
  const cls = thresholdCls(s.pct);
  const balance = s.win
    ? `最紧 <b>${esc(s.conn?.label || '')} · ${esc(s.win.label)}</b><br>${s.win.left != null ? `剩 <b>${fmt(s.win.left)}</b> / ${fmt(s.win.limit)}` : ''}`
    : ((d.connections || []).length ? '等待同步' : '尚未连接');
  const wins = s.conn?.windows || [];
  const minPct = wins.length ? Math.min(...wins.map(y => y.pct ?? 100)) : null;
  const tight = wins.filter(x => typeof x.pct === 'number' && x.pct <= 45 && x.pct === minPct)
    .map(x => `<div class="tight">最紧窗口：${esc(x.label)} ${x.pct}% · ${resetText(x)}，聚合已按它计算</div>`).join('');
  const scope = d.ui?.orbScope || 'all';
  const scopeNote = scope !== 'all'
    ? `<div class="scopenote">球体仅统计 <b>${esc(((d.connections || []).find(c => c.id === scope) || {}).label || '已删连接')}</b> · <a data-act="scope-all">恢复全部聚合</a></div>`
    : '';
  return `<div class="qp-hero">
    <div class="row1">
      <span class="big ${cls}">${s.pct == null ? '—' : Math.round(s.pct)}</span><span class="unit">% 剩余</span>
      <span class="balance">${balance}</span>
    </div>
    ${tight}${scopeNote}
  </div>`;
}

function connStateHTML(c) {
  if (c.excluded === 'disabled') return '<span class="cst">已停用</span>';
  if (c.excluded === 'auth') return '<span class="cst err">鉴权失败</span>';
  if (c.excluded === 'error') return `<span class="cst err" title="${esc(c.status?.message || '')}">同步出错</span> <a data-act="crefresh" data-id="${c.id}">重试</a>`;
  if (c.excluded === 'stale') return `<span class="cst warn">数据过期</span> <a data-act="crefresh" data-id="${c.id}">刷新</a>`;
  if (c.excluded === 'nosnap') return '<span class="cst">等待首次同步…</span>';
  if (c.status?.state === 'syncing') return '<span class="cst warn">正在同步…</span>';
  return `<span class="cst ok">✓</span><span class="cst">${fmtSyncTime(c.ts)} 同步 · 每 ${c.pollMinutes} 分钟</span>`;
}

function connCardHTML(c, bindingId) {
  const w = c.windows || [];
  const min = w.length ? Math.min(...w.map(x => x.pct ?? 100)) : null;
  return `<div class="conn${c.excluded ? ' off' : ''}${c.id === bindingId ? ' is-bind' : ''}">
    <div class="conn-head">
      <span class="pbadge">${pIcon(c.provider)}</span>
      <span class="conn-name">${esc(c.label)}</span>
      ${c.plan ? `<span class="conn-plan">${esc(c.plan)}</span>` : ''}
    </div>
    <div class="conn-state">${connStateHTML(c)}</div>
    ${w.length ? `<div class="wins">${w.map(x => `
      <div class="win ${x.pct === min ? 'binding' : ''}">
        <div class="w-head"><span class="w-label">${esc(x.label)}</span>${x.pct === min ? '<span class="w-bind">最紧</span>' : ''}</div>
        <div class="w-bar"><i style="width:${x.pct ?? 0}%"></i></div>
        <div class="w-meta">${x.left != null ? fmt(x.left) : '—'} <span class="mu">/ ${x.limit != null ? fmt(x.limit) : '—'} ${esc(x.unit || '')} · 剩 ${x.pct ?? '—'}%</span></div>
        <div class="w-reset">${resetText(x) || '—'}${x.pct === min ? ' · 决定当前可用量' : ''}</div>
      </div>`).join('')}</div>` : ''}
  </div>`;
}

function footHTML(ctx) {
  const conns = ctx.state.data.connections || [];
  let left;
  if (!conns.length) left = '<span>未连接</span>';
  else if (anySyncing(ctx)) left = '<span class="warn">正在同步…</span>';
  else {
    const okN = conns.filter(c => !c.excluded).length;
    const badN = conns.filter(c => c.excluded && c.excluded !== 'disabled').length;
    const lastTs = conns.reduce((m, c) => Math.max(m, c.ts || 0), 0);
    left = `<span>${okN}/${conns.length} 连接正常${badN ? ` · ${badN} 条异常` : ''} · ${fmtSyncTime(lastTs)} 同步</span> <a data-act="refresh">刷新</a>`;
  }
  return `<div class="qp-foot">${left}<span class="grow"></span>
    <a data-act="manage">${conns.length ? '管理连接' : '连接服务'}</a></div>`;
}

function mainHTML(ctx) {
  const d = ctx.state.data;
  const conns = d.connections || [];
  const bindingId = d.aggregate?.binding?.connId || null;
  const body = conns.length
    ? `<div class="qp-section-label">连接 · 按聚合排序</div>
      ${conns.map(c => connCardHTML(c, bindingId)).join('')}
      <div class="qp-setrow"><span>在此站点隐藏球体</span><span class="grow"></span><a data-act="hide">${esc(location.origin || '此站')}</a></div>
      <div class="qp-setrow"><span>侧边栏完整面板（全浏览器唯一实例）</span><span class="grow"></span><a data-act="sidepanel">打开 ↗</a></div>`
    : `<div class="qp-empty">
        <div class="ghost">${ICONS.spark}</div>
        <h4>连接用量服务</h4>
        <p>添加服务商连接后，球体将显示<br>所有连接中最紧的剩余百分比。</p>
        <button class="qp-cta" data-act="add">添加连接</button>
      </div>`;
  return `${headHTML(ctx)}${heroHTML(ctx)}
    <div class="qp-body">${body}</div>
    ${footHTML(ctx)}`;
}

/* ---------- 管理视图：启停 / 编辑 / 删除 / 排序 / 频率 / 球体关注 ---------- */
function manageHTML(ctx) {
  const d = ctx.state.data;
  const conns = d.connections || [];
  const scope = d.ui?.orbScope || 'all';
  const rows = conns.map((c, i) => `
    <div class="mrow${c.enabled === false ? ' off' : ''}">
      <div class="mline1">
        <span class="pbadge">${pIcon(c.provider)}</span>
        <span class="mname">${esc(c.label)}</span>
        <span class="msub">${esc((d.providers || []).find(p => p.id === c.provider)?.label || c.provider)}</span>
        <span class="mdot ${c.excluded ? (c.excluded === 'disabled' ? 'off' : 'err') : 'ok'}"></span>
      </div>
      <div class="mline2">
        <select class="pollsel" data-act="mpoll" data-id="${c.id}" title="同步频率">
          ${[1, 5, 15, 30, 60].map(m => `<option value="${m}"${c.pollMinutes === m ? ' selected' : ''}>${m}m</option>`).join('')}
        </select>
        <button class="mbtn" data-act="mup" data-id="${c.id}" title="上移" ${i === 0 ? 'disabled' : ''}>${ICONS.up}</button>
        <button class="mbtn" data-act="mdown" data-id="${c.id}" title="下移" ${i === conns.length - 1 ? 'disabled' : ''}>${ICONS.down}</button>
        <button class="mbtn ${scope === c.id ? 'on' : ''}" data-act="mscope" data-id="${c.id}" title="${scope === c.id ? '恢复全部聚合' : '球体只盯它'}">${ICONS.focus}</button>
        <button class="mbtn ${c.enabled === false ? '' : 'on'}" data-act="mtoggle" data-id="${c.id}" title="${c.enabled === false ? '启用' : '停用'}">${ICONS.power}</button>
        <button class="mbtn" data-act="medit" data-id="${c.id}" title="编辑">${ICONS.edit}</button>
        <button class="mbtn danger" data-act="mdel" data-id="${c.id}" title="删除">${ICONS.trash}</button>
      </div>
    </div>`).join('');
  return `${headHTML(ctx)}
    <div class="subhead" data-act="back"><span class="back">${ICONS.arrowl}</span>连接管理</div>
    <div class="mlist">${rows || '<div class="mempty">还没有连接</div>'}</div>
    <div class="btnrow"><button class="btn-save" data-act="add">${ICONS.plus}<span style="margin-left:7px;vertical-align:middle">添加连接</span></button></div>
    ${secNote()}
    ${footHTML(ctx)}`;
}

/* ---------- 声明式向导：全部字段/校验/提示来自 configSchema ---------- */
function currentWizardProvider(ctx) {
  const w = ctx.state.wizard || {};
  const providers = ctx.state.data.providers || [];
  return providers.find(p => p.id === w.providerId) || providers[0] || null;
}

function fieldHTML(f, val, editing) {
  if (f.type === 'segment') {
    return `<div class="seg-field"><label>${esc(f.label)}</label><div class="seg">${(f.options || []).map(o =>
      `<button data-act="wseg" data-name="${esc(f.name)}" data-v="${esc(o.value)}" class="${val === o.value ? 'on' : ''}">${esc(o.label)}</button>`).join('')}</div>
      ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}</div>`;
  }
  const isPw = f.type === 'password';
  const ph = isPw && editing ? '已保存 · 留空保持不变' : (isPw ? '粘贴后保存前不会离开本机' : (f.placeholder || ''));
  return `<div class="field">
    <label>${esc(f.label)}${f.required ? ' · 必填' : ''}</label>
    <div class="keybox">
      <input class="winput" id="wf_${esc(f.name)}" data-wname="${esc(f.name)}" type="${isPw ? 'password' : 'text'}"
        autocomplete="off" spellcheck="false" placeholder="${esc(ph)}" value="${esc(val || '')}">
      ${isPw ? `<div class="kbtns">
        <button class="kbtn" data-act="wpaste" data-for="${esc(f.name)}" title="粘贴">${ICONS.clip}</button>
        <button class="kbtn" data-act="weye" data-for="${esc(f.name)}" title="显示 / 隐藏">${ICONS.eye}</button>
      </div>` : ''}
    </div>
    ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}
  </div>`;
}

function wizardHTML(ctx) {
  const w = ctx.state.wizard || { values: {} };
  const providers = ctx.state.data.providers || [];
  const p = currentWizardProvider(ctx);
  const editing = !!w.connId;
  const provSeg = providers.length > 1
    ? `<div class="seg-field"><label>服务商</label><div class="seg">${providers.map(pp =>
        `<button data-act="wprov" data-id="${pp.id}" class="${pp.id === p?.id ? 'on' : ''}">${esc(pp.label)}</button>`).join('')}</div></div>`
    : `<div class="wprov"><span class="pbadge">${p ? pIcon(p.id) : ''}</span><b>${esc(p?.label || '')}</b>
        <span class="wtag">${p?.authMode === 'session' ? '登录态' : 'API 密钥'}</span></div>`;
  const v = w.values || {};
  const fieldsHTML = (p?.configSchema?.fields || []).map(f => fieldHTML(f, v[f.name], editing)).join('');
  const sessionNote = p?.authMode === 'session'
    ? `<div class="secnote"><div class="t">${ICONS.lock} 登录态接入（骨架预览）</div><ul>
        <li>该服务商将通过浏览器登录会话读取用量，无需粘贴密钥</li>
        <li>captureSession 流程在后续版本开放</li>
      </ul></div>`
    : '';
  return `${headHTML(ctx)}
    <div class="subhead" data-act="wback"><span class="back">${ICONS.arrowl}</span>${editing ? '编辑连接' : '添加连接'}</div>
    ${provSeg}
    <div class="field">
      <label>连接名称（用于区分多个连接）</label>
      <div class="keybox"><input class="winput" data-wname="__label" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(p?.label || '')}" value="${esc(v.__label || '')}"></div>
    </div>
    ${p?.authMode === 'session' ? sessionNote : fieldsHTML}
    <div class="btnrow"><button class="btn-save" id="wSave">验证并保存</button></div>
    <div class="fhint" id="wHint" style="margin:0 16px">保存前会先调用服务商用量接口验证；凭据仅保存在本机</div>
    ${p?.authMode !== 'session' ? secNote() : ''}
    ${footHTML(ctx)}`;
}

/* 校验与后台 validateConfig 同语义：required + minLength（validate 函数过不了消息总线）。
 * 编辑连接时 password 留空视为合法 —— 后台按「保持已存凭据」合并。 */
function checkWizard(ctx) {
  const w = ctx.state.wizard;
  const p = currentWizardProvider(ctx);
  const v = w?.values || {};
  for (const f of p?.configSchema?.fields || []) {
    const val = String(v[f.name] ?? '').trim();
    if (f.required && !val && !(w.connId && f.type === 'password')) return '请填写' + f.label;
    if (val && f.minLength && val.length < f.minLength) return f.label + '至少 ' + f.minLength + ' 个字符';
  }
  return null;
}

function startWizard(ctx, connId = null) {
  const providers = ctx.state.data.providers || [];
  const conn = connId ? (ctx.state.data.connections || []).find(c => c.id === connId) : null;
  const providerId = conn?.provider || providers[0]?.id || null;
  const p = providers.find(x => x.id === providerId);
  const values = { __label: conn?.label || '' };
  for (const f of p?.configSchema?.fields || []) {
    values[f.name] = f.type === 'password' ? ''
      : conn ? (conn.safeConfig?.[f.name] ?? '')
      : f.type === 'segment' ? (f.default ?? f.options?.[0]?.value ?? '') : '';
  }
  ctx.state.wizard = { connId, providerId, values, from: ctx.state.subView === 'manage' ? 'manage' : null };
  ctx.state.subView = 'wizard';
  renderPanel(ctx);
}

function kindTail(kind) {
  return kind === 'auth' ? ' · 请检查凭据与区域'
    : kind === 'noPlan' ? ' · 账号可能未订阅；团队席位请填组织 / 项目 ID'
    : kind === 'context' ? ' · 请核对组织 / 项目 ID（区分大小写）'
    : ' · 可到设置 → 调试查看详情';
}

function wireWizard(ctx) {
  const panel = ctx.panel;
  const state = ctx.state;
  const w = state.wizard;
  if (state.subView !== 'wizard' || !w) return;
  const p = currentWizardProvider(ctx);

  panel.querySelector('[data-act="wback"]')?.addEventListener('click', () => {
    state.wizard = null;
    state.subView = w.from === 'manage' ? 'manage' : null;
    renderPanel(ctx);
  });
  panel.querySelectorAll('[data-act="wprov"]').forEach(b => b.addEventListener('click', () => {
    const np = (state.data.providers || []).find(x => x.id === b.dataset.id);
    const values = { __label: w.values.__label || '' };
    for (const f of np?.configSchema?.fields || []) {
      values[f.name] = f.type === 'segment' ? (f.default ?? f.options?.[0]?.value ?? '') : '';
    }
    state.wizard = { connId: null, providerId: np?.id, values, from: w.from };
    renderPanel(ctx);
  }));
  panel.querySelectorAll('[data-act="wseg"]').forEach(b => b.addEventListener('click', () => {
    w.values[b.dataset.name] = b.dataset.v;
    renderPanel(ctx);
  }));

  const hint = panel.querySelector('#wHint');
  const save = panel.querySelector('#wSave');
  const chk = () => {
    const err = checkWizard(ctx);
    if (save) save.disabled = !!err;
    if (hint) {
      hint.className = 'fhint' + (err ? '' : ' ok');
      hint.textContent = err || '格式就绪 · 将调用服务商用量接口验证后，仅保存在本机';
    }
  };
  panel.querySelectorAll('input.winput').forEach(inp => inp.addEventListener('input', () => {
    w.values[inp.dataset.wname] = inp.value;
    chk();
  }));
  panel.querySelectorAll('[data-act="weye"]').forEach(b => b.addEventListener('click', () => {
    const inp = panel.querySelector('#wf_' + b.dataset.for);
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    b.innerHTML = show ? ICONS.eyeoff : ICONS.eye;
  }));
  panel.querySelectorAll('[data-act="wpaste"]').forEach(b => b.addEventListener('click', async () => {
    const inp = panel.querySelector('#wf_' + b.dataset.for);
    if (!inp) return;
    try { inp.value = (await navigator.clipboard.readText() || '').trim(); w.values[inp.dataset.wname] = inp.value; chk(); } catch {}
    inp.focus();
  }));

  save?.addEventListener('click', async () => {
    if (!p || state.testing) return;
    const config = {};
    for (const f of p.configSchema?.fields || []) config[f.name] = String(w.values[f.name] ?? '').trim();
    const label = String(w.values.__label || '').trim() || p.label;
    state.testing = true;
    save.classList.add('testing');
    save.innerHTML = '<span class="spin"></span>正在验证…';
    if (hint) { hint.className = 'fhint'; hint.textContent = '正在调用服务商用量接口验证…'; }
    const r = await send({ type: 'quorb/conn:save', id: w.connId || undefined, provider: w.providerId, label, config });
    state.testing = false;
    if (r?.ok) {
      const from = w.from;
      state.wizard = null;
      state.subView = from === 'manage' ? 'manage' : null;
      await reload(ctx);
      if (from === 'manage') renderPanel(ctx); else closePanel(ctx);
    } else {
      save.innerHTML = '重试验证';
      save.disabled = false;
      if (hint) {
        hint.className = 'fhint err';
        hint.textContent = (r?.message || '验证失败') + kindTail(r?.kind);
      }
    }
  });
  chk();
}

async function moveConn(ctx, id, delta) {
  const order = (ctx.state.data.connections || []).map(c => c.id);
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  await send({ type: 'quorb/ui:save', order });
  await reload(ctx);
}

export function renderPanel(ctx) {
  const panel = ctx.panel;
  if (!panel) return;
  const state = ctx.state;
  panel.classList.toggle('mat-dark', state.matDark);
  panel.innerHTML = state.subView === 'manage' ? manageHTML(ctx)
    : state.subView === 'wizard' ? wizardHTML(ctx)
    : mainHTML(ctx);

  /* 通用 */
  panel.querySelector('[data-act="close"]')?.addEventListener('click', () => closePanel(ctx));
  panel.querySelector('[data-act="options"]')?.addEventListener('click', () => send({ type: 'quorb/openOptions' }));

  /* 主视图 */
  panel.querySelector('[data-act="manage"]')?.addEventListener('click', () => { state.subView = 'manage'; renderPanel(ctx); });
  panel.querySelector('[data-act="add"]')?.addEventListener('click', () => startWizard(ctx));
  panel.querySelector('[data-act="refresh"]')?.addEventListener('click', async () => {
    setLocalSync(ctx, true);
    await send({ type: 'quorb/conn:refresh' });
    setLocalSync(ctx, false);
    await reload(ctx);
  });
  panel.querySelectorAll('[data-act="crefresh"]').forEach(a => a.addEventListener('click', async () => {
    setLocalSync(ctx, true);
    await send({ type: 'quorb/conn:refresh', id: a.dataset.id });
    setLocalSync(ctx, false);
    await reload(ctx);
  }));
  panel.querySelector('[data-act="scope-all"]')?.addEventListener('click', async () => {
    await send({ type: 'quorb/ui:save', orbScope: 'all' });
    await reload(ctx);
  });
  panel.querySelector('[data-act="hide"]')?.addEventListener('click', async () => {
    await send({ type: 'quorb/toggleOrigin', origin: location.origin });
    unmount(ctx);
  });
  panel.querySelector('[data-act="sidepanel"]')?.addEventListener('click', () => send({ type: 'quorb/openSidePanel' }));

  /* 管理视图 */
  panel.querySelector('[data-act="back"]')?.addEventListener('click', () => { state.subView = null; renderPanel(ctx); });
  panel.querySelectorAll('[data-act="mpoll"]').forEach(sel => sel.addEventListener('change', async () => {
    await send({ type: 'quorb/conn:setPoll', id: sel.dataset.id, minutes: Number(sel.value) });
    await reload(ctx);
  }));
  panel.querySelectorAll('[data-act="mtoggle"]').forEach(b => b.addEventListener('click', async () => {
    const c = (state.data.connections || []).find(x => x.id === b.dataset.id);
    await send({ type: 'quorb/conn:toggle', id: b.dataset.id, enabled: c?.enabled === false });
    await reload(ctx);
  }));
  panel.querySelectorAll('[data-act="mscope"]').forEach(b => b.addEventListener('click', async () => {
    const cur = state.data.ui?.orbScope || 'all';
    await send({ type: 'quorb/ui:save', orbScope: cur === b.dataset.id ? 'all' : b.dataset.id });
    await reload(ctx);
  }));
  panel.querySelectorAll('[data-act="medit"]').forEach(b => b.addEventListener('click', () => startWizard(ctx, b.dataset.id)));
  panel.querySelectorAll('[data-act="mdel"]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.classList.add('armed');
      b.title = '再次点击确认删除';
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.classList.remove('armed'); b.title = '删除'; } }, 3000);
      return;
    }
    await send({ type: 'quorb/conn:delete', id: b.dataset.id });
    if (state.data.ui?.orbScope === b.dataset.id) await send({ type: 'quorb/ui:save', orbScope: 'all' });
    await reload(ctx);
  }));
  panel.querySelectorAll('[data-act="mup"]').forEach(b => b.addEventListener('click', () => moveConn(ctx, b.dataset.id, -1)));
  panel.querySelectorAll('[data-act="mdown"]').forEach(b => b.addEventListener('click', () => moveConn(ctx, b.dataset.id, 1)));

  /* 向导 */
  wireWizard(ctx);

  placePanel(ctx);
}
