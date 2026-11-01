/* ============================================================
 * quorb · content script 入口（v2：多连接聚合展示）
 * 单一 Shadow Root 承载 球体 + 面板；密钥从不进入内容脚本。
 * 模块拆分：main(入口/生命周期) · bridge(消息) · orb(球体) · panel(面板)
 * 调试：URL hash 带 #quorb-open 自动展开面板；#quorb-hide 不挂载。
 * ============================================================ */
import { send, reload, onStorageChanged } from './bridge.js';
import { detectDark, renderOrb, clampPos, renderPos, dockOffset, savePos, wireOrb } from './orb.js';
import { openPanel, closePanel, placePanel, renderPanel, openConnect } from './panel.js';

(() => {
  if (window.top !== window) return;                    // 不进 iframe
  if (document.getElementById('quorb-host')) return;    // 防重复注入（常驻注入 + 清单注入并存）
  if (location.protocol.startsWith('chrome')) return;   // 不进扩展页
  if (location.hash.includes('quorb-hide')) return;

  const MYV = (chrome.runtime.getManifest?.() || {}).version || '0';
  const host = document.createElement('div');
  host.id = 'quorb-host';
  const root = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);

  /* ---------- 状态 ---------- */
  const state = {
    data: {
      schemaVersion: 2,
      connections: [],
      aggregate: { globalPct: null, binding: null },
      ui: { orbScope: 'all', pos: null, docked: null, hiddenOrigins: [], order: [] },
      providers: [],
    },
    pos: { x: Math.max(24, innerWidth - 110), y: Math.max(90, Math.round(innerHeight * 0.28)) },
    home: null,   // 用户放置的权威坐标（持久化它）；pos 只是渲染用瞬时坐标，视口收窄时被临时收紧
    docked: null, dockBase: null, panelOpen: false,
    subView: null,      // null | 'manage' | 'wizard'
    wizard: null,       // { connId, providerId, values, from } —— 向导草稿（输入值持久，重渲染不丢）
    localSync: false, matDark: false, testing: false,
  };
  /* 模块间共享上下文：state + Shadow DOM 节点引用 + 事件回调句柄 */
  const ctx = { host, root, state, MYV, styleEl: null, orbSlot: null, panel: null, orbEl: null, onStorageChanged: null };

  async function mountUI() {
    try {
      console.info('[quorb] v' + ((chrome.runtime.getManifest?.() || {}).version || '?') + ' · UI 已挂载 @', location.host);
      ctx.styleEl = document.createElement('style');
      try {
        const css = await (await fetch(chrome.runtime.getURL('src/content/ui.css'))).text();
        ctx.styleEl.textContent = css;
      } catch (e) { ctx.styleEl.textContent = ''; console.info('[quorb] css load failed', e); }
      ctx.root.appendChild(ctx.styleEl);

      ctx.orbSlot = document.createElement('div');
      ctx.orbSlot.className = 'q-orb-slot grab';
      if (state.docked) ctx.orbSlot.classList.add('docked');   // 恢复停靠标记（供 wireOrb 悬停滑出逻辑使用）
      ctx.root.appendChild(ctx.orbSlot);

      ctx.panel = document.createElement('div');
      ctx.panel.className = 'q-panel closing';
      ctx.panel.setAttribute('role', 'dialog');
      ctx.panel.setAttribute('aria-label', 'quorb 用量详情');
      ctx.root.appendChild(ctx.panel);

      state.matDark = detectDark();
      renderOrb(ctx);
      wireOrb(ctx);
      if (location.hash.includes('quorb-open')) openPanel(ctx);
    } catch (e) { console.info('[quorb] mount failed', e); }
  }

  /* ---------- 面板关闭手势（与原版同一注册时机：脚本求值期） ---------- */
  document.addEventListener('pointerdown', e => {
    if (!state.panelOpen) return;
    if (!e.composedPath().includes(host)) closePanel(ctx);
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(ctx); });

  /* 后台标签页的定时器/事件可能被浏览器节流：切回标签页时立即拉取最新快照，消除显示延迟 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reload(ctx);
  });

  /* 视口几何变化统一纠正（举一反三：侧边栏开合 / 窗口缩放 / DevTools 停靠 / 全屏切换）。
     球体是 fixed 定位、不随文档流，视口变小时旧坐标会出界或被覆盖：
     停靠态按新视口重新贴边；自由态收紧回界内；展开的小面板重定位。 */
  let rsT;
  window.addEventListener('resize', () => {
    clearTimeout(rsT);
    rsT = setTimeout(() => {
      if (!ctx.orbSlot) return;
      if (state.docked) {
        state.pos = { ...dockOffset(state.docked) };
        state.dockBase = { ...state.pos };
      } else {
        // 从「家」重新收敛而不是 clamp 当前值：视口重新变宽时球能弹回原位
        state.pos = clampPos(state.home || state.pos);
      }
      renderPos(ctx, true);
      if (state.panelOpen) placePanel(ctx);
      savePos(ctx);
    }, 120);   // 防抖：侧边栏开合/窗口拖拽会连发多次 resize
  });

  ctx.onStorageChanged = (changes, area) => onStorageChanged(ctx, changes, area);
  chrome.runtime.onMessage.addListener(m => {
    if (m?.type === 'quorb/openConnect' && !state.panelOpen) openConnect(ctx);
  });

  /* ---------- 启动 ---------- */
  (async () => {
    try {
    const r = await send({ type: 'quorb/get' });
    if (r?.ok) {
      state.data = { ...state.data, ...r };
      if ((r.ui?.hiddenOrigins || []).includes(location.origin)) { host.remove(); return; }
      if (r.ui?.pos) { state.home = r.ui.pos; state.pos = clampPos(r.ui.pos); }
      // 此时 orbSlot 尚未创建（mountUI 在下方才执行），这里绝不能碰 DOM；
      // 之前在此 add class 会抛 TypeError 被外层 catch 吞掉 → mountUI 不再执行 → 球消失
      if (r.ui?.docked) { state.pos = clampPos(dockOffset(r.ui.docked)); state.docked = r.ui.docked; state.dockBase = { ...state.pos }; }
    }
    state.matDark = detectDark();
    await mountUI();
    chrome.storage.onChanged.addListener(ctx.onStorageChanged);   // UI 就绪后再监听，避免竞态
    renderPos(ctx, false);
    setInterval(() => { if (state.panelOpen && state.subView !== 'wizard') renderPanel(ctx); }, 30000);
    if (location.hash.includes('quorb-open')) openPanel(ctx);
    } catch (e) { console.info('[quorb] init failed', e); }
  })();
})();
