/* quorb · 设置页逻辑（P2 多连接：连接列表 · 声明式表单 · 逐连接自检 / 调试）
 * 服务商知识为零：字段、校验、提示全部来自 providers[]（quorb/get 下发的 configSchema 摘要）。
 * 凭据红线：password 字段从不回显（safeConfig 只给「已保存」掩码）；编辑时留空 = 保持已存值。 */
import { ICONS, PROVIDER_ICONS } from '../shared/icons.js';
import { fmtSyncTime } from '../shared/format.js';

const $ = s => document.querySelector(s);
const send = msg => new Promise(r => {
  try { chrome.runtime.sendMessage(msg, res => { try { void chrome.runtime.lastError; } catch {} r(res || { ok: false }); }); }
  catch { r({ ok: false }); }
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let DATA = null;        // quorb/get 响应缓存
let form = null;        // { connId, providerId, values } —— 表单草稿
let rawConnId = null;   // 调试视图当前选中的连接

const providerOf = id => (DATA?.providers || []).find(p => p.id === id) || null;
const connOf = id => (DATA?.connections || []).find(c => c.id === id) || null;
const segFieldOf = p => (p?.configSchema?.fields || []).find(f => f.type === 'segment') || null;
const regionOption = (p, region) => {
  const f = segFieldOf(p);
  return (f?.options || []).find(o => o.value === region) || null;
};

function setHint(el, text, cls = '') { el.className = 'hint ' + cls; el.textContent = text; }

/* ---------- 连接列表 ---------- */
function stateText(c) {
  return c.excluded === 'disabled' ? '已停用'
    : c.excluded === 'auth' ? '鉴权失败'
    : c.excluded === 'error' ? '同步出错' + (c.status?.message ? '：' + c.status.message : '')
    : c.excluded === 'stale' ? '数据过期'
    : c.excluded === 'nosnap' ? '等待首次同步'
    : c.status?.state === 'syncing' ? '正在同步…'
    : '正常 · ' + fmtSyncTime(c.ts);
}

function renderConns() {
  const conns = DATA?.connections || [];
  const el = $('#connList');
  if (!conns.length) {
    el.innerHTML = '<div class="hint">还没有连接 —— 点击下方「添加连接」，凭据验证通过后才会落盘。</div>';
    return;
  }
  el.innerHTML = conns.map(c => {
    const p = providerOf(c.provider);
    return `<div class="crow" data-id="${c.id}">
      <span class="pbadge">${PROVIDER_ICONS[c.provider] || ICONS.spark}</span>
      <div class="cmeta">
        <div class="cname">${esc(c.label)}</div>
        <div class="csub">${esc((p?.label || c.provider) + ' · ' + stateText(c))}${c.windows?.length ? ' · ' + c.windows.length + ' 个窗口' : ''}</div>
      </div>
      <span class="grow"></span>
      <span class="cdot ${c.excluded ? (c.excluded === 'disabled' ? 'off' : 'err') : 'ok'}" title="${esc(stateText(c))}"></span>
      <select class="pollmin" data-act="cpoll" data-id="${c.id}" title="同步频率">${[1, 5, 15, 30, 60].map(m => `<option value="${m}"${c.pollMinutes === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}</select>
      <button class="mini" data-act="ctoggle" data-id="${c.id}">${c.enabled === false ? '启用' : '停用'}</button>
      <button class="mini" data-act="cedit" data-id="${c.id}">编辑</button>
      <button class="mini danger" data-act="cdel" data-id="${c.id}">删除</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-act="cpoll"]').forEach(sel => sel.addEventListener('change', async () => {
    await send({ type: 'quorb/conn:setPoll', id: sel.dataset.id, minutes: Number(sel.value) });
    refresh();
  }));
  el.querySelectorAll('[data-act="ctoggle"]').forEach(b => b.addEventListener('click', async () => {
    const c = connOf(b.dataset.id);
    await send({ type: 'quorb/conn:toggle', id: c.id, enabled: c.enabled === false });
    refresh();
  }));
  el.querySelectorAll('[data-act="cedit"]').forEach(b => b.addEventListener('click', () => startForm(b.dataset.id)));
  el.querySelectorAll('[data-act="cdel"]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.classList.add('armed');
      b.textContent = '确认删除？';
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.classList.remove('armed'); b.textContent = '删除'; } }, 3000);
      return;
    }
    const r = await send({ type: 'quorb/conn:delete', id: b.dataset.id });
    setHint($('#connHint'), r?.ok ? '已删除连接与快照' : (r?.message || '删除失败'), r?.ok ? 'ok' : 'err');
    refresh();
  }));
}

/* ---------- 声明式连接表单 ---------- */
function fieldHTML(f, val, editing) {
  if (f.type === 'segment') {
    return `<label>${esc(f.label)}</label>
      <div class="segopt">${(f.options || []).map(o => `<button type="button" class="segbtn${val === o.value ? ' on' : ''}" data-act="fseg" data-name="${esc(f.name)}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div>
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}`;
  }
  const isPw = f.type === 'password';
  const ph = isPw && editing ? '已保存 · 留空保持不变' : (isPw ? '粘贴后保存前不会离开本机' : (f.placeholder || ''));
  return `<label>${esc(f.label)}${f.required ? ' · 必填' : ''}</label>
    <div class="keyrow"><input id="ff_${esc(f.name)}" data-wname="${esc(f.name)}" type="${isPw ? 'password' : 'text'}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false" value="${isPw ? '' : esc(val || '')}">
    ${isPw ? `<button class="kbtn" data-act="feye" data-for="${esc(f.name)}" title="显示 / 隐藏">👁</button>` : ''}</div>
    ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}`;
}

function checkForm() {
  const p = providerOf(form.providerId);
  for (const f of p?.configSchema?.fields || []) {
    const val = String(form.values[f.name] ?? '').trim();
    if (f.required && !val && !(form.connId && f.type === 'password')) return '请填写' + f.label;
    if (val && f.minLength && val.length < f.minLength) return f.label + '至少 ' + f.minLength + ' 个字符';
  }
  return null;
}

function checkFormUI() {
  const err = checkForm();
  $('#formSave').disabled = !!err;
  setHint($('#formHint'), err || '格式就绪 · 将调用服务商用量接口验证后，仅保存在本机', err ? 'err' : 'ok');
}

function wireFormFields() {
  $('#provSeg').querySelectorAll('[data-act="fprov"]').forEach(b => b.addEventListener('click', () => {
    const np = providerOf(b.dataset.id);
    const values = { __label: form.values.__label || '' };
    for (const f of np?.configSchema?.fields || []) {
      values[f.name] = f.type === 'segment' ? (f.default ?? f.options?.[0]?.value ?? '') : '';
    }
    form = { connId: null, providerId: np?.id, values };
    renderFormFields();
    updateConsoleLink();
  }));
  $('#formFields').querySelectorAll('[data-act="fseg"]').forEach(b => b.addEventListener('click', () => {
    form.values[b.dataset.name] = b.dataset.v;
    renderFormFields();
    updateConsoleLink();
  }));
  $('#formFields').querySelectorAll('input[data-wname]').forEach(inp => inp.addEventListener('input', () => {
    form.values[inp.dataset.wname] = inp.value;
    checkFormUI();
  }));
  $('#formFields').querySelectorAll('[data-act="feye"]').forEach(b => b.addEventListener('click', () => {
    const i = $('#ff_' + b.dataset.for);
    if (i) i.type = i.type === 'password' ? 'text' : 'password';
  }));
}

function renderFormFields() {
  const p = providerOf(form.providerId);
  const editing = !!form.connId;
  $('#formFields').innerHTML = (p?.configSchema?.fields || []).map(f => fieldHTML(f, form.values[f.name], editing)).join('');
  $('#provSeg').innerHTML = (DATA?.providers || []).length > 1
    ? `<label>服务商</label><div class="segopt">${(DATA.providers || []).map(pp =>
        `<button type="button" class="segbtn${pp.id === form.providerId ? ' on' : ''}" data-act="fprov" data-id="${pp.id}">${esc(pp.label)}</button>`).join('')}</div>`
    : `<span class="pbadge" style="display:inline-flex;width:22px;height:22px;border-radius:8px;align-items:center;justify-content:center;background:oklch(52% .115 205/.14);color:oklch(45% .1 205)">${PROVIDER_ICONS[p?.id] || ICONS.spark}</span><b style="margin-left:8px">${esc(p?.label || '')}</b>${p?.authMode === 'session' ? '<span class="wtag">登录态</span>' : '<span class="wtag">API 密钥</span>'}`;
  $('#fLabel').value = form.values.__label || '';
  $('#fLabel').placeholder = p?.label || '';
  $('#formTitle').textContent = editing ? '编辑连接' : '添加连接';
  wireFormFields();
  checkFormUI();
}

function startForm(connId = null) {
  const conn = connId ? connOf(connId) : null;
  const providerId = conn?.provider || (DATA?.providers || [])[0]?.id || null;
  const p = providerOf(providerId);
  if (!p) return;
  const values = { __label: conn?.label || '' };
  for (const f of p.configSchema?.fields || []) {
    values[f.name] = f.type === 'password' ? ''
      : conn ? (conn.safeConfig?.[f.name] ?? '')
      : f.type === 'segment' ? (f.default ?? f.options?.[0]?.value ?? '') : '';
  }
  form = { connId, providerId, values };
  $('#formCard').style.display = '';
  renderFormFields();
  updateConsoleLink();
  $('#formCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function kindTail(kind) {
  return kind === 'auth' ? ' · 请检查凭据与区域'
    : kind === 'noPlan' ? ' · 账号可能未订阅；团队席位请填组织 / 项目 ID'
    : kind === 'context' ? ' · 请核对组织 / 项目 ID（区分大小写）'
    : '';
}

$('#formSave').addEventListener('click', async () => {
  if (!form) return;
  const p = providerOf(form.providerId);
  const config = {};
  for (const f of p?.configSchema?.fields || []) config[f.name] = String(form.values[f.name] ?? '').trim();
  const label = String(form.values.__label || '').trim() || p.label;
  const btn = $('#formSave');
  btn.disabled = true; btn.textContent = '正在验证…';
  setHint($('#formHint'), '正在调用服务商用量接口验证…');
  const r = await send({ type: 'quorb/conn:save', id: form.connId || undefined, provider: form.providerId, label, config });
  btn.disabled = false; btn.textContent = '验证并保存';
  if (r?.ok) {
    form = null;
    $('#formCard').style.display = 'none';
    const n = r.windows?.length ?? 0;
    setHint($('#connHint'), '验证通过 · 解析 ' + n + ' 个用量窗口' + (r.plan ? ' · ' + r.plan : ''), 'ok');
  } else {
    setHint($('#formHint'), (r?.message || '验证失败') + kindTail(r?.kind), 'err');
  }
  refresh();
  renderDiag();
});

$('#formCancel').addEventListener('click', () => { form = null; $('#formCard').style.display = 'none'; });
$('#addBtn').addEventListener('click', () => startForm(null));

/* ---------- 球体显示 ---------- */
function renderSites() {
  const sites = DATA?.ui?.hiddenOrigins || [];
  $('#sites').innerHTML = sites.length
    ? sites.map(s => `<div class="site"><span class="grow">${esc(s)}</span><a data-site="${esc(s)}">恢复显示</a></div>`).join('')
    : '<div class="hint">暂无隐藏的站点</div>';
  $('#sites').querySelectorAll('[data-site]').forEach(a => a.addEventListener('click', async () => {
    await send({ type: 'quorb/toggleOrigin', origin: a.dataset.site });
    refresh();
  }));
}

/* ---------- 调试：按连接查看原始返回 ---------- */
async function renderDebug() {
  const conns = DATA?.connections || [];
  const sel = $('#rawConn');
  if (!conns.length) {
    sel.innerHTML = '<option value="">（无连接）</option>';
    sel.disabled = true;
    $('#raw').textContent = '（尚未连接）';
    return;
  }
  sel.disabled = false;
  if (!conns.find(c => c.id === rawConnId)) rawConnId = conns[0].id;
  sel.innerHTML = conns.map(c => `<option value="${c.id}"${c.id === rawConnId ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  const r = await send({ type: 'quorb/snap:get', id: rawConnId });
  $('#raw').textContent = r?.ok ? JSON.stringify(r.snap.raw, null, 2) : '（' + (r?.message || '无快照') + '）';
}
$('#rawConn').addEventListener('change', () => { rawConnId = $('#rawConn').value; renderDebug(); });

/* ---------- 健康自检（逐连接） ---------- */
async function renderDiag() {
  const d = await Promise.race([
    send({ type: 'quorb/diagnose' }),
    new Promise(r => setTimeout(() => r({ ok: false, message: '后台 10 秒未响应，请到 chrome://extensions 重载 quorb 后重试' }), 10000)),
  ]);
  const el = $('#diag');
  if (!d?.ok) { setHint(el, '自检失败：' + (d?.message || ''), 'err'); return; }
  const rows = [];
  rows.push({ flag: d.alarmScheduled ? '✓' : '△', text: '定时同步：' + (d.alarmScheduled ? '已排程' : '未排程（重载扩展修复）') });
  rows.push({ flag: d.connectionCount ? '✓' : '△', text: d.connectionCount ? d.connectionCount + ' 条连接 · 隐藏站点 ' + (d.hiddenOrigins.length ? d.hiddenOrigins.join('、') : '无') : '未连接任何服务' });
  for (const c of d.connections || []) {
    const okFlag = c.enabled && c.state === 'ok' && !c.stale && c.windowsCount > 0;
    rows.push({
      flag: !c.enabled ? '△' : okFlag ? '✓' : '✗',
      text: c.label + '：' + (!c.enabled ? '已停用'
        : c.state + (c.stale ? '（数据过期）' : '') + (c.message ? '（' + c.message + '）' : '')
          + ' · ' + c.windowsCount + ' 窗口 · 每 ' + c.pollMinutes + ' 分钟'),
    });
  }
  el.innerHTML = rows.map(r => `<div style="display:flex;gap:6px"><span style="flex:none">${r.flag}</span><span>${esc(r.text)}</span></div>`).join('');
  el.className = 'hint';
}

/* ---------- 控制台链接（从 configSchema 选项读取，无服务商字面量） ---------- */
function updateConsoleLink() {
  const a = $('#consoleLink');
  const pid = form?.providerId || connOf(rawConnId)?.provider || (DATA?.connections || [])[0]?.provider || (DATA?.providers || [])[0]?.id || null;
  const p = providerOf(pid);
  const region = form?.values?.region || (DATA?.connections || []).find(c => c.provider === pid)?.safeConfig?.region;
  const opt = regionOption(p, region);
  if (opt?.consoleUrl) {
    a.style.display = '';
    a.href = opt.consoleUrl;
    a.textContent = '打开 ' + (p?.label || '') + ' 控制台 ↗';
  } else {
    a.style.display = 'none';
  }
}

/* ---------- 刷新与全局动作 ---------- */
async function refresh() {
  const d = await send({ type: 'quorb/get' });
  if (!d?.ok) { setHint($('#connHint'), '无法连接后台：' + (d?.message || ''), 'err'); return; }
  DATA = d;
  renderConns();
  renderSites();
  await renderDebug();
  updateConsoleLink();
}

$('#refreshNow').addEventListener('click', async () => {
  setHint($('#connHint'), '正在同步…');
  const r = await send({ type: 'quorb/conn:refresh' });
  setHint($('#connHint'), r?.ok ? '同步完成 · ' + (r.synced ?? '') : '同步失败：' + (r?.message || '未知错误'), r?.ok ? 'ok' : 'err');
  refresh();
  renderDiag();
});

refresh();
renderDiag();
