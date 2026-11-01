/* quorb · Side Panel —— 全浏览器唯一实例的完整面板
 * P2 多连接：聚合口径与来源标注直接取后台 aggregate（shared/aggregate.js 同源数据视图）；
 * 数据只读；同步由 service worker 独占执行；连接管理动作进设置页。 */
import { fmt, fmtSyncTime, resetText, thresholdCls } from '../shared/format.js';
import { ICONS, PROVIDER_ICONS } from '../shared/icons.js';

const $ = s => document.querySelector(s);
const send = msg => new Promise(r => {
  try {
    chrome.runtime.sendMessage(msg, res => { try { void chrome.runtime.lastError; } catch {} r(res || { ok: false }); });
  } catch { r({ ok: false }); }
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function winCard(x, min) {
  const bind = x.pct === min;
  return `<div class="win ${bind ? 'binding' : ''}">
    <div class="w-head"><span class="w-label">${esc(x.label)}</span>${bind ? '<span class="w-bind">最紧</span>' : ''}</div>
    <div class="w-bar"><i style="width:${x.pct ?? 0}%"></i></div>
    <div class="w-meta">${x.left != null ? fmt(x.left) : '—'} <span class="mu">/ ${x.limit != null ? fmt(x.limit) : '—'} ${esc(x.unit || '')} · 剩 ${x.pct ?? '—'}%</span></div>
    <div class="w-reset">${resetText(x) || '—'}${bind ? ' · 决定当前可用量' : ''}</div>
  </div>`;
}

function connCard(c, bindingId) {
  const w = c.windows || [];
  const min = w.length ? Math.min(...w.map(x => x.pct ?? 100)) : null;
  const bad = c.excluded && c.excluded !== 'disabled';
  const st = c.excluded === 'disabled' ? '已停用'
    : c.excluded === 'auth' ? '鉴权失败 · 请重新填写凭据'
    : c.excluded === 'error' ? '同步出错' + (c.status?.message ? ' · ' + c.status.message : '')
    : c.excluded === 'stale' ? '数据过期 · 打开悬浮球面板刷新'
    : c.excluded === 'nosnap' ? '等待首次同步'
    : c.status?.state === 'syncing' ? '正在同步…'
    : fmtSyncTime(c.ts) + ' 同步 · 每 ' + c.pollMinutes + ' 分钟刷新';
  return `<div class="conn${c.excluded ? ' off' : ''}${c.id === bindingId ? ' is-bind' : ''}">
    <div class="conn-head">
      <span class="pbadge">${PROVIDER_ICONS[c.provider] || ICONS.spark}</span>
      <span class="conn-name">${esc(c.label)}</span>
      ${c.plan ? `<span class="conn-plan">${esc(c.plan)}</span>` : ''}
    </div>
    <div class="conn-state${bad ? ' bad' : ''}" title="${bad ? esc(c.status?.message || '') : ''}">${esc(st)}</div>
    ${w.length ? `<div class="wins">${w.map(x => winCard(x, min)).join('')}</div>` : ''}
  </div>`;
}

function render(d) {
  const main = $('#main');
  const conns = d?.connections || [];
  if (!conns.length) {
    main.innerHTML = `
      <div class="empty">
        <div class="ghost">${ICONS.spark}</div>
        <h4>连接用量服务</h4>
        <p>在任意网页点击悬浮球 → 添加连接，<br>支持同一服务商的多套凭据并行聚合。</p>
        <button class="cta" id="go">前往连接</button>
        <div class="tinynote">密钥仅保存在本机 · 不上传</div>
      </div>`;
    $('#go').addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) await send({ type: 'quorb/openConnect', tabId: tab.id });
      else setHint('请先打开任意网页，再从悬浮球连接');
    });
    return;
  }
  const agg = d.aggregate || {};
  const pct = agg.globalPct;
  const cls = thresholdCls(pct);
  const bc = agg.binding ? conns.find(c => c.id === agg.binding.connId) : null;
  const bwin = agg.binding?.window || null;
  const balance = bwin
    ? `最紧 <b>${esc(bc?.label || '')} · ${esc(bwin.label)}</b><br>${bwin.left != null ? `剩 <b>${fmt(bwin.left)}</b> / ${fmt(bwin.limit)}` : ''}`
    : '等待同步';
  const tight = (bc?.windows || []).filter(x => typeof x.pct === 'number' && x.pct <= 45 && x.pct === Math.min(...bc.windows.map(y => y.pct ?? 100)))
    .map(x => `<div class="tight">最紧窗口：${esc(x.label)} ${x.pct}% · ${resetText(x)}，聚合已按它计算</div>`).join('');
  const syncing = conns.some(c => c.status?.state === 'syncing');
  const bad = conns.filter(c => c.excluded && c.excluded !== 'disabled');
  const lastTs = conns.reduce((m, c) => Math.max(m, c.ts || 0), 0);
  const foot = syncing ? '正在同步…'
    : bad.length ? bad.length + ' 条连接异常 · ' + fmtSyncTime(lastTs)
    : fmtSyncTime(lastTs) + ' 同步';
  main.innerHTML = `
    <div class="hero">
      <span class="big ${cls}">${pct == null ? '—' : Math.round(pct)}</span><span class="unit">% 剩余</span>
      <span class="balance">${balance}</span>
    </div>
    ${tight}
    <div class="sec">连接 · 按聚合排序</div>
    ${conns.map(c => connCard(c, agg.binding?.connId)).join('')}
    <div class="foot"><span class="${syncing ? 'warn' : bad.length ? 'err' : ''}">${esc(foot)}</span><span class="grow"></span>
      <a id="manage">管理连接</a></div>`;
  $('#manage').addEventListener('click', () => send({ type: 'quorb/openOptions' }));
}

function setHint(t) { const e = document.createElement('div'); e.className = 'tinynote'; e.textContent = t; $('#main').appendChild(e); }

$('#refresh').addEventListener('click', async () => { await send({ type: 'quorb/conn:refresh' }); refresh(); });
$('#options').addEventListener('click', () => send({ type: 'quorb/openOptions' }));
let t; function refreshSoon() { clearTimeout(t); t = setTimeout(refresh, 150); }
/* v2 键族（conn:<id> / snap:<id> / ui / meta）任一变化都触发刷新 */
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  const ks = Object.keys(ch);
  if (ks.some(k => k === 'ui' || k === 'meta' || k.startsWith('snap:') || k.startsWith('conn:'))) refreshSoon();
});

/* 拉取快照 → 渲染（所有入口统一走这里） */
async function refresh() {
  try {
    const d = await send({ type: 'quorb/get' });
    render(d?.ok ? d : { connections: [], aggregate: {} });
  } catch (e) {
    console.error('[quorb][sidepanel] refresh failed', e);
    render({ connections: [], aggregate: {} });
  }
}
refresh();
setInterval(refresh, 30000);
