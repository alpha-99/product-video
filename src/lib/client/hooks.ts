"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { messageOf } from "./api";
import {
  DEFAULT_STALE_MS,
  readCacheEntry,
  writeCache,
  type CacheEntry,
} from "./cache";

/**
 * 服务端没有模块级内存缓存，SSR 输出的 HTML 只能是骨架；若沿用 useEffect，
 * 缓存要等浏览器 paint 之后才回填，用户会看到骨架闪一下（验收反馈的「抖动条」）。
 * 客户端改用 layout effect，在 paint 前同步回填缓存并切成数据；服务端退化成
 * useEffect，避免 React 的 useLayoutEffect SSR 告警。两种实现都占一个 hook 槽，
 * hook 顺序保持一致，不会造成 hydration 不匹配。
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * 验收第 9 章：后台刷新失败但仍有旧数据时，不再静默无提示。
   * 这是非致命提示，页面可显示一条轻横幅，不覆盖列表内容。
   */
  refreshError: string | null;
}

export interface UseAsyncOptions {
  /** 同一 key 的数据在页面间共享；不传则退化为「每次挂载都请求」。 */
  cacheKey?: string;
  /** 新鲜期：命中且未过期时直接用缓存，不发请求。默认 0（总是后台刷新）。 */
  ttlMs?: number;
  /** 缓存最长可用时长，超过则回落骨架屏。默认 10 分钟。 */
  staleMs?: number;
}

/**
 * 通用异步数据：loading / error / data 三态 + 手动 reload。
 *
 * stale-while-revalidate：缓存里有数据时立即渲染旧数据、后台静默刷新，
 * loading 只在「完全没有可用数据」时为 true。这样切换菜单不再闪骨架屏，
 * 也不会把「正在刷新」误显示成空列表（0 套 / 共 0 条）。
 * reload() 会绕过新鲜期强制请求；有旧数据时同样不显示骨架。
 *
 * 缓存回填走 layout effect（见 useIsomorphicLayoutEffect），保证命中缓存时
 * 首帧就是真实内容，骨架不会在屏幕上出现哪怕一帧。
 */
export function useAsync<T>(loader: () => Promise<T>, options: UseAsyncOptions = {}) {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
    refreshError: null,
  });
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // options 通常是内联对象，放进 ref 避免每次渲染都让 effect 重跑。
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const forceRef = useRef(false);

  const reload = useCallback(() => {
    forceRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  useIsomorphicLayoutEffect(() => {
    const { cacheKey, ttlMs = 0, staleMs = DEFAULT_STALE_MS } = optionsRef.current;
    const cached: CacheEntry<T> | null = cacheKey
      ? readCacheEntry<T>(cacheKey, staleMs)
      : null;
    const force = forceRef.current;
    forceRef.current = false;

    // 新鲜缓存：连请求都不发（模板这类几乎不变的数据）。
    if (cached && !force && Date.now() - cached.at < ttlMs) {
      setState({ data: cached.data, loading: false, error: null, refreshError: null });
      return;
    }

    // 有旧数据就保留内容后台刷新；没数据才进入加载态。
    setState(
      cached
        ? { data: cached.data, loading: false, error: null, refreshError: null }
        : { data: null, loading: true, error: null, refreshError: null }
    );

    let alive = true;
    loaderRef.current()
      .then((data) => {
        if (!alive) return;
        if (cacheKey) writeCache(cacheKey, data);
        setState({ data, loading: false, error: null, refreshError: null });
      })
      .catch((error) => {
        if (!alive) return;
        // 后台刷新失败时保留旧数据，但透出一条非致命提示，
        // 避免「状态长期不更新且页面毫无反馈」（验收第 9 章第 6 项）。
        setState(
          cached
            ? { data: cached.data, loading: false, error: null, refreshError: messageOf(error) }
            : { data: null, loading: false, error: messageOf(error), refreshError: null }
        );
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  return { ...state, reload };
}

export { clearCache as clearAsyncCache, invalidateCache as invalidateAsyncCache } from "./cache";

/**
 * 条件轮询：仅在 active 时启动；页面隐藏时暂停，恢复可见立即补一次。
 * 用于视频任务状态，避免后台标签页空转打数据库。
 */
export function usePolling(callback: () => void, active: boolean, intervalMs = 5000) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      cbRef.current();
    };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, intervalMs]);
}
