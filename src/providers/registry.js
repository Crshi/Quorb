/* quorb · 服务商注册表（docs/architecture.md §3）
 * 新增服务商：实现契约后在 REGISTRY 加一行 —— 不改 UI / 后台其余代码。 */
import glm from './glm.js';

export const REGISTRY = { glm };

export function getProvider(id) {
  return REGISTRY[id] || null;
}

/* 供向导渲染的摘要（不含实现） */
export function listProviders() {
  return Object.values(REGISTRY).map(p => ({
    id: p.id,
    label: p.label,
    icon: p.icon,
    authMode: p.authMode,
    configSchema: p.configSchema,
  }));
}
