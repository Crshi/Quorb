/* quorb · 球体 —— 渲染、悬浮提示、拖拽 / 磁吸 / 停靠
 * 纯视觉与交互层：数字口径来自 shared/aggregate（displayStat 尊重 ui.orbScope）；
 * 面板开关调用 panel.closePanel。 */
import { resetText, bindingWin, thresholdCls } from '../shared/format.js';
import { send } from './bridge.js';
import { closePanel } from './panel.js';

export const ORB = 56;

/* tip / aria 注入的用户可见字符串（连接 label 属用户输入）统一转义 */
const escT = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 亮度探测 → Clear / Dusk ---------- */
export function detectDark() {
  try {
    for (const el of [document.body, document.documentElement]) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/[\d.]+/g);
      if (m && m.length >= 3 && !(m.length === 4 && parseFloat(m[3]) === 0)) {
        const [r, g, b] = m.map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
      }
    }
  } catch {}
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

/* ---------- 球体 ---------- */
let uid = 0;
export function orbHTML({ pct, syncing, unset, matDark: dark }) {
  const id = 'qg' + (++uid);
  const C = 2 * Math.PI * 25;
  const p = unset ? 0 : (pct ?? 0);
  const ring = unset ? 'ring-none' : p <= 20 ? 'ring-crit' : p <= 45 ? 'ring-warn' : 'ring-ok';
  const glow = unset ? 'transparent' : p <= 20 ? 'oklch(60% .19 22/.55)' : p <= 45 ? 'oklch(72% .135 75/.55)' : 'oklch(72% .085 190/.5)';
  const center = unset
    ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8h3l2-4 2 8 2-4h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/></svg>'
    : `<span class="orb-num">${Math.round(p)}</span><span class="orb-pct">%</span>`;
  return `<div class="orb ${ring} ${dark ? 'mat-dark' : ''}${syncing ? ' is-syncing' : ''}${p <= 20 && !unset ? ' is-crit' : ''}"
    style="--glow:${glow}" role="img" aria-label="quorb 剩余 ${Math.round(p)}%">
    <svg class="orb-svg" viewBox="0 0 56 56" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="oklch(52% .115 205)"/><stop offset="1" stop-color="oklch(72% .085 190)"/>
      </linearGradient></defs>
      <circle class="orb-track" cx="28" cy="28" r="25"/>
      <circle class="orb-prog" cx="28" cy="28" r="25" stroke="url(#${id})" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - p / 100)).toFixed(1)}"/>
    </svg>
    <div class="orb-core">${center}</div>
    <span class="sheen"></span>
    ${syncing ? '' : ''}
  </div>`;
}

/* ---------- 聚合口径（P2）：球体数字 = ui.orbScope 指向连接的最紧 pct；
 * scope === 'all' 时取 aggregate.globalPct（跨连接最紧，shared/aggregate.js 同源）。 ---------- */
export function displayStat(ctx) {
  const d = ctx.state.data || {};
  const conns = d.connections || [];
  const scope = d.ui?.orbScope || 'all';
  if (scope !== 'all') {
    const c = conns.find(x => x.id === scope) || null;
    if (!c || c.excluded || typeof c.pct !== 'number') return { pct: null, conn: c, win: null };
    return { pct: c.pct, conn: c, win: bindingWin(c.windows) || null };
  }
  const b = d.aggregate?.binding || null;
  const conn = b ? (conns.find(c => c.id === b.connId) || null) : null;
  return { pct: d.aggregate?.globalPct ?? null, conn, win: b?.window || null };
}

export function currentPct(ctx) { return displayStat(ctx).pct; }

export function renderOrb(ctx) {
  if (!ctx.orbSlot) return;
  const d = ctx.state.data;
  const conns = d.connections || [];
  const pct = currentPct(ctx);
  const syncing = ctx.state.localSync || conns.some(c => c.status?.state === 'syncing');
  ctx.orbSlot.innerHTML = orbHTML({ pct, syncing, unset: !conns.length || pct == null, matDark: ctx.state.matDark })
    + `<div class="q-tip ${ctx.state.matDark ? 'mat-dark' : ''}">${tipText(ctx)}</div>`;
  ctx.orbEl = ctx.orbSlot.querySelector('.orb');
  ctx.orbEl.classList.toggle('mat-dark', ctx.state.matDark);
  if (conns.some(c => c.status?.state === 'auth')) ctx.orbEl.insertAdjacentHTML('beforeend', '<span class="orb-badge">!</span>');
}

function tipText(ctx) {
  const d = ctx.state.data;
  const conns = d.connections || [];
  if (!conns.length) return `<div class="qt-head"><b>尚未连接</b></div><div class="qt-sub">单击球体打开面板 → 添加连接</div>`;
  if (ctx.state.localSync || conns.some(c => c.status?.state === 'syncing')) return '<div class="qt-head"><b>正在同步…</b></div>';
  const usable = conns.filter(c => !c.excluded && typeof c.pct === 'number');
  if (!usable.length) {
    const c = conns[0];
    const why = c.excluded === 'stale' ? '数据过期 —— 打开面板点「刷新」'
      : c.excluded === 'auth' ? '鉴权失败 —— 到「管理连接」重新填写凭据'
      : c.excluded === 'error' ? '同步出错' + (c.status?.message ? '：' + escT(c.status.message) : '')
      : c.excluded === 'disabled' ? '连接已停用'
      : '等待首次同步';
    return `<div class="qt-head"><b>${escT(c.label)}</b></div><div class="qt-sub">${why}</div>`;
  }
  const cls = p => { const c = thresholdCls(p); return c ? ' ' + c : ''; };
  /* 单连接：沿用逐窗口明细；多连接：每连接一行（标注聚合来源） */
  if (usable.length === 1 && conns.length === 1) {
    const c = usable[0];
    const w = c.windows || [];
    const b = bindingWin(w);
    return `<div class="qt-head"><span class="qt-tag">最紧</span><b>${escT(b.label)}</b><span class="qt-big${cls(b.pct)}">${b.pct ?? '—'}<small>%</small></span></div>`
      + w.map(x => `<div class="qt-item">
          <div class="qt-row"><span class="lbl">${escT(x.label)}</span><span class="bar"><i class="${cls(x.pct)}" style="width:${Math.max(2, x.pct ?? 0)}%"></i></span><span class="pct${cls(x.pct)}">${x.pct ?? '—'}%</span></div>
          ${x.resetAt ? `<div class="qt-sub">${resetText(x)}</div>` : ''}
        </div>`).join('');
  }
  const s = displayStat(ctx);
  const headLabel = s.conn && s.win ? s.conn.label + ' · ' + s.win.label : '聚合';
  return `<div class="qt-head"><span class="qt-tag">聚合</span><b>${escT(headLabel)}</b><span class="qt-big${cls(s.pct)}">${s.pct == null ? '—' : Math.round(s.pct)}<small>%</small></span></div>`
    + usable.slice().sort((a, b2) => a.pct - b2.pct).map(c => {
        const bw = bindingWin(c.windows);
        return `<div class="qt-item">
          <div class="qt-row${c.id === s.conn?.id ? ' is-bind' : ''}"><span class="lbl">${escT(c.label)}</span><span class="bar"><i class="${cls(c.pct)}" style="width:${Math.max(2, c.pct)}%"></i></span><span class="pct${cls(c.pct)}">${c.pct}%</span></div>
          ${bw ? `<div class="qt-sub">${escT(bw.label)} · ${resetText(bw)}</div>` : ''}
        </div>`;
      }).join('');
}

/* 悬浮提示：气泡由 CSS 锚定在槽内坐标（球体上方居中）；点亮后按视口实测做边界自适应 ——
   水平越界则平移收拢，顶部放不下则翻转到球下方。
   注意：只能「读」getBoundingClientRect 做测量，不能把视口坐标「写」进 left/top（见 ui.css 注释） */
function showTip(ctx, on) {
  const t = ctx.orbSlot?.querySelector('.q-tip');
  if (!t) return;
  if (!on) { t.classList.remove('on'); return; }
  t.classList.add('on');
  // 测量期间必须禁用过渡并强制回流：否则清空内联 transform 会触发 160ms 动画，
  // getBoundingClientRect 读到的是动画中途值，多次 hover 时修正量算错 → 仍被屏幕边缘裁剪
  const prevTrans = t.style.transition;
  t.style.transition = 'opacity 160ms cubic-bezier(.22,1,.36,1)';   // 仅保留淡入；禁掉 transform 动画
  t.style.top = ''; t.style.transform = '';          // 先回到默认锚点再测量
  void t.offsetWidth;                                 // 强制回流，拿到动画终点的真实位置
  const r = t.getBoundingClientRect();
  const M = 8;                                        // 与屏幕边缘的最小间距
  let shift = 0;
  if (r.left < M) shift = M - r.left;
  else if (r.right > innerWidth - M) shift = (innerWidth - M) - r.right;
  if (r.top < M) {                                    // 上方放不下 → 翻到球下方（56px 球 + 10px 间距）
    t.style.top = '66px';
    t.style.transform = `translate(-50%,0)${shift ? ` translateX(${Math.round(shift)}px)` : ''}`;
  } else if (shift) {
    t.style.transform = `translate(-50%,-100%) translateX(${Math.round(shift)}px)`;
  }
  t.style.transition = prevTrans;                     // 恢复淡入动画
}

/* ---------- 球体拖拽 / 停靠 / 点击 ---------- */
export function clampPos(p) {
  return {
    x: Math.min(Math.max(p.x, -ORB * 0.52), innerWidth - ORB * 0.48),
    y: Math.min(Math.max(p.y, -ORB * 0.52), innerHeight - ORB * 0.48),
  };
}

export function renderPos(ctx, anim) {
  if (!ctx.orbSlot) return;
  ctx.orbSlot.classList.toggle('dock-anim', !!anim);
  ctx.orbSlot.style.transform = `translate(${ctx.state.pos.x}px, ${ctx.state.pos.y}px)`;
}

export function dockOffset(side) {
  const W = innerWidth, H = innerHeight;
  return {
    left: { x: -ORB * 0.52, y: (H - ORB) / 2 },
    right: { x: W - ORB * 0.48, y: (H - ORB) / 2 },
    top: { x: (W - ORB) / 2, y: -ORB * 0.52 },
    bottom: { x: (W - ORB) / 2, y: H - ORB * 0.48 },
  }[side];
}

function nearestEdge(ctx) {
  const cx = ctx.state.pos.x + ORB / 2, cy = ctx.state.pos.y + ORB / 2;
  const d = { left: cx, right: innerWidth - cx, top: cy, bottom: innerHeight - cy };
  return Object.entries(d).sort((a, b) => a[1] - b[1])[0];
}

function dockTo(ctx, side) {
  ctx.state.pos = { ...dockOffset(side) };
  ctx.state.dockBase = { ...ctx.state.pos };
  ctx.state.docked = side;
  ctx.orbSlot.classList.add('docked');
  renderPos(ctx, true);
  savePos(ctx);
}

function undock(ctx) {
  ctx.state.docked = null; ctx.state.dockBase = null;
  ctx.orbSlot.classList.remove('docked');
  ctx.state.pos = clampPos({ x: Math.min(innerWidth - ORB - 48, 420), y: Math.round(innerHeight * 0.3) });
  ctx.state.home = { ...ctx.state.pos };   // 解停靠的落点即新「家」
  renderPos(ctx, true);
  savePos(ctx);
}

let savePosT;
export function savePos(ctx) {
  clearTimeout(savePosT);
  savePosT = setTimeout(() => send({ type: 'quorb/ui:save', pos: ctx.state.home || ctx.state.pos, docked: ctx.state.docked }), 400);
}

export function wireOrb(ctx) {
  const orbSlot = ctx.orbSlot;
  let drag = null;
  let suppressClick = false;
  orbSlot.addEventListener('mouseenter', () => showTip(ctx, true));
  orbSlot.addEventListener('mouseleave', () => showTip(ctx, false));
  orbSlot.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    // 不要 preventDefault：它会抑制兼容 mousedown → 鼠标不产生 transient activation，
    // 后台 sidePanel.open() 将因「无 user gesture」被拒；防误选交给 CSS user-select
    orbSlot.setPointerCapture(e.pointerId);
    drag = { sx: e.clientX, sy: e.clientY, ox: ctx.state.pos.x, oy: ctx.state.pos.y, moved: false };
    orbSlot.classList.add('dragging');
  });
  orbSlot.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 6) {
      drag.moved = true;
      ctx.state.docked = null; ctx.state.dockBase = null;
      orbSlot.classList.remove('docked');
      ctx.orbEl?.classList.add('is-drag');
      closePanel(ctx);
    }
    if (drag.moved) {
      ctx.state.pos = clampPos({ x: drag.ox + dx, y: drag.oy + dy });
      renderPos(ctx, false);
    }
  });
  orbSlot.addEventListener('pointerup', () => {
    if (!drag) return;
    orbSlot.classList.remove('dragging');
    ctx.orbEl?.classList.remove('is-drag');
    const wasDrag = drag.moved; drag = null;
    suppressClick = wasDrag;
    if (wasDrag) {
      const n = nearestEdge(ctx);
      n[1] <= 20 ? dockTo(ctx, n[0]) : ((ctx.state.home = { ...ctx.state.pos }), renderPos(ctx, true), savePos(ctx));
    }
  });
  // 单击 → 开关侧边栏：必须走原生 click（mousedown 产生手势，click 紧随其后），
  // 不能挂在 pointerup 上 —— 鼠标的 pointerup 不是 activation 事件，手势链路断裂
  orbSlot.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    send({ type: 'quorb/toggleSidePanel' }).then(r => {
      if (r && r.ok) console.info('[quorb] 侧边栏已' + (r.open ? '显示' : '隐藏'));
      else if (r) console.info('[quorb] 侧边栏切换失败:', r.message || '');
    });
  });
  orbSlot.addEventListener('pointercancel', () => { drag = null; orbSlot.classList.remove('dragging'); });
  orbSlot.addEventListener('dblclick', () => {
    if (ctx.state.docked) undock(ctx); else dockTo(ctx, nearestEdge(ctx)[0]);
  });
  orbSlot.addEventListener('mouseenter', () => {
    if (!ctx.state.docked || drag || !ctx.state.dockBase) return;
    const off = { left: [16, 0], right: [-16, 0], top: [0, 16], bottom: [0, -16] }[ctx.state.docked];
    ctx.state.pos = { x: ctx.state.dockBase.x + off[0], y: ctx.state.dockBase.y + off[1] };
    renderPos(ctx, true);
  });
  orbSlot.addEventListener('mouseleave', () => {
    if (!ctx.state.docked || drag || !ctx.state.dockBase) return;
    ctx.state.pos = { ...ctx.state.dockBase };
    renderPos(ctx, true);
  });
}
