/* quorb · content bridge —— 与后台的唯一通道
 * send：消息发送；reload：拉取 quorb/get（v2 结构）并驱动 UI 重渲染；
 * onStorageChanged：v2 键族（conn:<id> / snap:<id> / ui / meta）订阅（main.js 注册）。
 * localSync：手动刷新的本地乐观态（立即反映 syncing，storage 写回后自动校正）。 */
import { renderOrb, renderPos, clampPos } from './orb.js';
import { renderPanel } from './panel.js';

export const send = (msg) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage(msg, r => void (chrome.runtime.lastError, resolve(r || { ok: false })));
  } catch { resolve({ ok: false }); }
});

export async function reload(ctx) {
  const r = await send({ type: 'quorb/get' });
  if (r?.ok) {
    ctx.state.data = { ...ctx.state.data, ...r };
    ctx.state.localSync = false;
    if ((r.ui?.hiddenOrigins || []).includes(location.origin)) { unmount(ctx); return false; }
    if (r.ui?.pos && !ctx.state.docked) { ctx.state.home = r.ui.pos; ctx.state.pos = clampPos(r.ui.pos); }
    renderOrb(ctx); renderPos(ctx, false);
    /* 向导输入中不打断（输入值已持久在 state.wizard.values，下次渲染不丢） */
    if (ctx.state.panelOpen && ctx.state.subView !== 'wizard') renderPanel(ctx);
  }
  return true;
}

export function unmount(ctx) {
  try { chrome.storage.onChanged.removeListener(ctx.onStorageChanged); } catch {}
  ctx.host.remove();
}

export function onStorageChanged(ctx, changes, area) {
  if (area !== 'local') return;
  const ks = Object.keys(changes);
  if (ks.some(k => k === 'ui' || k === 'meta' || k.startsWith('snap:') || k.startsWith('conn:'))) reload(ctx);
}

export function setLocalSync(ctx, on = true) {
  ctx.state.localSync = on;
  renderOrb(ctx);
  if (ctx.state.panelOpen && ctx.state.subView !== 'wizard') renderPanel(ctx);
}
