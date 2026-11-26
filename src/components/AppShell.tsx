"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, messageOf } from "../lib/client/api";
import { writeCache } from "../lib/client/cache";
import { clearAsyncCache, useAsync } from "../lib/client/hooks";
import type { Me, ProductDto, TemplateDto, VideoJobDto } from "../lib/client/types";
import { useToast } from "./Toaster";

/** 主导航唯一数据源：侧栏（桌面）与顶部条（窄屏）共用，避免 active 判定分叉。 */
const NAV = [
  { href: "/", label: "工作台", icon: "◫" },
  { href: "/create", label: "视频创作", icon: "✦" },
  { href: "/products", label: "商品管理", icon: "▦" },
  { href: "/templates", label: "模板选择", icon: "▤" },
  { href: "/videos", label: "视频管理", icon: "▶" },
] as const;

interface ShellContextValue {
  me: Me | null;
  refreshMe: () => void;
  account: React.ReactNode;
}

const ShellContext = createContext<ShellContextValue>({
  me: null,
  refreshMe: () => undefined,
  account: null,
});

export function useShell() {
  return useContext(ShellContext);
}

/** 页面右上角账户区：头像 + 额度 + 主题 + 退出。 */
export function Account() {
  const { account } = useShell();
  return <div className="who">{account}</div>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { data: me, reload } = useAsync<Me>(() => api.get<Me>("/api/me"), {
    cacheKey: "me",
  });
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = localStorage.getItem("pv-theme");
    if (stored === "dark" || stored === "light") setTheme(stored);
  }, []);

  /**
   * 空闲预热：登录进站后把四个列表数据填进共享缓存。
   * 用户点任意菜单时页面可立即渲染，不必先闪一遍骨架屏等跨境数据库。
   * 与页面自身的请求由 api.get 的 in-flight 去重合并，不会重复查询。
   */
  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const warm = () => {
      void Promise.allSettled([
        api.get<TemplateDto[]>("/api/templates").then((d) => writeCache("templates", d)),
        api.get<ProductDto[]>("/api/products?take=100").then((d) => writeCache("products", d)),
        api.get<VideoJobDto[]>("/api/videos?take=100").then((d) => writeCache("videos", d)),
      ]);
    };
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(warm, { timeout: 1200 });
      return () => win.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(warm, 200);
    return () => window.clearTimeout(timer);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("pv-theme", next);
  };

  const logout = useCallback(async () => {
    try {
      await api.delete("/api/auth/session");
      // 清掉账户/列表缓存，避免下一个登录账号看到上一账号的数据。
      clearAsyncCache();
      router.push("/login");
      router.refresh();
    } catch (error) {
      toast.show(messageOf(error), true);
    }
  }, [router, toast]);

  const account = (
    <>
      <span className="muted">剩余额度 {me?.quotaLeft ?? "—"} 次</span>
      <span className="avatar" title={me?.email}>{(me?.email ?? "U").slice(0, 1).toUpperCase()}</span>
      <button className="icon-btn" onClick={toggleTheme} aria-label="切换深浅主题" title="切换主题">
        {theme === "dark" ? "☀" : "◐"}
      </button>
      <button className="icon-btn" onClick={logout} aria-label="退出登录" title="退出登录">↪</button>
    </>
  );

  // 两处导航共用同一份 active 判定与 aria-current（P0-1 / R-03）。
  const navItems = NAV.map((item) => ({ ...item, active: pathname === item.href }));

  return (
    <>
      <a className="skip-link" href="#main-content">跳转到主要内容</a>
      <div className="app-body">
        {/* 窄屏（<1024px）主导航改顶部：额度、主题切换、退出一并收进顶部条 */}
        <div className="top-nav-bar">
          <span className="tn-brand"><i>P</i> ProductVideo</span>
          <nav className="tn-links" aria-label="主导航">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={item.active ? "active" : ""}
                aria-current={item.active ? "page" : undefined}
              >
                <span aria-hidden="true">{item.icon}</span> {item.label}
              </Link>
            ))}
          </nav>
          <div className="tn-account">{account}</div>
        </div>

        <aside className="app-side">
          <div className="logo"><i>P</i> ProductVideo</div>
          <nav aria-label="主导航">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={item.active ? "active" : ""}
                aria-current={item.active ? "page" : undefined}
              >
                <span className="ico" aria-hidden="true">{item.icon}</span> {item.label}
              </Link>
            ))}
          </nav>
          {/* P2-2：移除写死的套餐占位，只保留 /api/me 返回的真实额度。 */}
          <div className="side-foot">
            剩余额度 <b>{me?.quotaLeft ?? "—"}</b> 次
          </div>
        </aside>

        <main className="app-main" id="main-content" tabIndex={-1}>
          <ShellContext.Provider value={{ me, refreshMe: reload, account }}>
            {children}
          </ShellContext.Provider>
        </main>
      </div>
    </>
  );
}
