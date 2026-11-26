/**
 * 客户端数据缓存（阶段八补充）。
 *
 * 只缓存「读多写少、可按 reload 强制刷新」的列表/账户数据，作用域是当前页面会话：
 *   - 模块级 Map，切换到别的菜单页时不随组件卸载而丢失；
 *   - 退出登录或跳转登录页时清空，避免跨账号串数据；
 *   - 整页刷新（含 401 跳登录）自然失效，不落 localStorage。
 *
 * 目的：菜单切换时先用上次数据渲染，再后台刷新（stale-while-revalidate），
 * 避免每次点菜单都闪一遍骨架屏。
 */

export interface CacheEntry<T> {
  data: T;
  at: number;
}

/** 超过此时长的数据不再复用，退回加载态；默认 10 分钟。 */
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

const store = new Map<string, CacheEntry<unknown>>();

export function readCacheEntry<T>(
  key: string,
  staleMs: number = DEFAULT_STALE_MS
): CacheEntry<T> | null {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.at > staleMs) {
    store.delete(key);
    return null;
  }
  return entry;
}

export function writeCache<T>(key: string, data: T): void {
  store.set(key, { data, at: Date.now() });
}

export function clearCache(): void {
  store.clear();
}

/**
 * 只失效指定 key（验收 P2-12）。
 * 提交新任务、重试、取消、删除后调用，避免用户在页面间切换时
 * 从共享缓存里短暂看到上一份旧列表。
 */
export function invalidateCache(key: string): void {
  store.delete(key);
}

/** 仅供测试与诊断。 */
export function cacheSize(): number {
  return store.size;
}
