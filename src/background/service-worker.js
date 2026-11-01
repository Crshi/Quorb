/* ============================================================
 * quorb · background service worker（v2 数据面）
 * 职责收窄为：生命周期 · 消息路由 · 侧边栏手势逻辑。
 * 同步编排 → orchestrator.js；连接 CRUD/迁移/组装 → connections.js（架构见 docs/architecture.md）。
 * 密钥仅存本机 chrome.storage.local，绝不使用 storage.sync。
 * ============================================================ */
import { syncDue, syncConnection } from './orchestrator.js';
import {
  runMigration, cleanupV1Keys, saveConnection, deleteConnection, toggleConnection,
  setConnectionPoll, refreshAll, buildGetResponse, buildDiagnose, getSnapRaw,
} from './connections.js';
import { REGISTRY } from '../providers/registry.js';
import { getUi, setUi, getConnection } from '../lib/store.js';

const TICK_ALARM = 'quorb-tick';   // 单一 1 分钟 tick：到期过滤在 orchestrator（D5）

/* 常驻保障：向所有已打开的 http/https 标签页注入内容脚本
   （扩展安装/重载后，Chrome 只会在「之后加载」的页面注入——已打开的标签需要这一步补齐） */
async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    const results = await Promise.allSettled(tabs.map(t =>
      chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: false },
        files: ['dist/content/index.js'],
      }).catch(() => {})
    ));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    console.info('[quorb][sw] 常驻注入：' + ok + '/' + tabs.length + ' 个标签页');
  } catch (e) {
    console.info('[quorb][sw] 常驻注入跳过:', e && e.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch {}
  await runMigration();                                    // v1(cfg/snap/status) → v2(conn:/snap:/ui)，旧键保留
  await cleanupV1Keys();                                   // §4.2：跨版本后清理旧键
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  syncDue('install');
  injectIntoExistingTabs();
});

chrome.runtime.onStartup.addListener(() => { syncDue('startup'); injectIntoExistingTabs(); });

chrome.alarms.onAlarm.addListener(al => {
  if (al.name === TICK_ALARM) syncDue('alarm');
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

/* ---------- 侧边栏开合（原样保留：open 前零 await 的手势约束） ---------- */
/* Side Panel 开合状态：内存 Map 即决策来源，storage.session 仅作镜像。
   关键约束：chrome.sidePanel.open() 依赖消息携带的 user gesture，
   处理器里一旦先 await（如读 storage），手势即失效 → 点击无响应。
   因此决策必须零 await；SW 重启后 Map 为空视为「未打开」，重复 open 幂等无害。 */
const panelOpenMem = new Map();
function setPanelOpen(windowId, open) {
  panelOpenMem.set(windowId, open);
  void chrome.storage.session.set({ ['sp' + windowId]: open });
}

/* ---------- 消息总线（v2 新消息 + v1 兼容映射，P2 收敛） ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      /* ----- v2 数据面 ----- */
      case 'quorb/get': {
        sendResponse(await buildGetResponse());
        break;
      }
      case 'quorb/conn:save': {
        sendResponse(await saveConnection(msg));
        break;
      }
      case 'quorb/conn:delete': {
        sendResponse(await deleteConnection(msg.id));
        break;
      }
      case 'quorb/conn:toggle': {
        sendResponse(await toggleConnection(msg));
        break;
      }
      case 'quorb/conn:setPoll': {
        sendResponse(await setConnectionPoll(msg));
        break;
      }
      case 'quorb/conn:refresh': {
        sendResponse(msg.id ? await refreshOne(msg.id) : await refreshAll());
        break;
      }

      /* ----- P2：ui 状态与调试（v1 兼容消息已按 D9「同进同退」全部移除） ----- */
      case 'quorb/ui:save': {
        const patch = {};
        for (const k of ['pos', 'docked', 'order', 'orbScope']) if (k in msg) patch[k] = msg[k];
        await setUi(patch);
        sendResponse({ ok: true });
        break;
      }
      case 'quorb/snap:get': {
        sendResponse(await getSnapRaw(msg.id));
        break;
      }
      case 'quorb/toggleOrigin': {
        const ui = await getUi();
        const list = new Set(ui.hiddenOrigins || []);
        list.has(msg.origin) ? list.delete(msg.origin) : list.add(msg.origin);
        await setUi({ hiddenOrigins: [...list] });
        sendResponse({ ok: true, hidden: list.has(msg.origin) });
        break;
      }
      case 'quorb/diagnose': {
        try {
          const alarm = await chrome.alarms.get(TICK_ALARM);
          sendResponse(await buildDiagnose(!!alarm));
        } catch (e) { sendResponse({ ok: false, message: String(e) }); }
        break;
      }

      /* ----- 通用 ----- */
      case 'quorb/openOptions': {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;
      }
      case 'quorb/openConnect': {
        try { await chrome.tabs.sendMessage(msg.tabId, { type: 'quorb/openConnect' }); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, message: String(e) }); }
        break;
      }
      case 'quorb/openSidePanel': {
        const windowId = _sender.tab?.windowId;
        if (windowId != null) {
          // setOptions 与 open 在同一同步任务内发起，保住 user gesture
          const enable = chrome.sidePanel.setOptions({ windowId, enabled: true });
          const opening = chrome.sidePanel.open({ windowId });
          await Promise.all([enable, opening]);
          setPanelOpen(windowId, true);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'quorb/toggleSidePanel': {
        try {
          const windowId = _sender.tab?.windowId;
          if (windowId == null) { sendResponse({ ok: false, message: '无法定位窗口' }); break; }
          if (panelOpenMem.get(windowId)) {
            await chrome.sidePanel.setOptions({ windowId, enabled: false });
            setPanelOpen(windowId, false);
            console.info('[quorb][sw] 侧边栏已隐藏 (window ' + windowId + ')');
            sendResponse({ ok: true, open: false });
          } else {
            // 打开分支在此前没有任何 await：open() 必须在 gesture 有效期内同步发起
            const enable = chrome.sidePanel.setOptions({ windowId, enabled: true });
            const opening = chrome.sidePanel.open({ windowId });
            await Promise.all([enable, opening]);
            setPanelOpen(windowId, true);
            console.info('[quorb][sw] 侧边栏已显示 (window ' + windowId + ')');
            sendResponse({ ok: true, open: true });
          }
        } catch (e) {
          console.info('[quorb][sw] 侧边栏切换失败:', e && e.message);
          sendResponse({ ok: false, message: e && e.message });
        }
        break;
      }
      case 'quorb/openConsole': {
        const p = REGISTRY[msg.provider];
        const url = p ? (typeof p.consoleUrl === 'function' ? p.consoleUrl(msg.config || {}) : p.consoleUrl) : null;
        if (url) { chrome.tabs.create({ url }); sendResponse({ ok: true }); }
        else sendResponse({ ok: false, message: '该服务商未提供控制台地址' });
        break;
      }
      default:
        sendResponse({ ok: false, message: 'unknown message' });
    }
  })();
  return true; // async sendResponse
});

/* 单连接手动刷新 */
async function refreshOne(id) {
  const conn = await getConnection(id);
  if (!conn) return { ok: false, message: '连接不存在' };
  return syncConnection(conn);
}

export {};
