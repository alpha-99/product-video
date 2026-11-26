/**
 * 布局稳定性静态回归守卫：
 * 1) 单条目时卡片栅格不得撑满整行（auto-fill 保留空轨道）；
 * 2) 骨架不得带位移动画，缓存命中时首帧就渲染真实数据；
 * 3) 预留滚动条槽位，避免内容高度变化引起整页横向抖动。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const ruleOf = (css: string, selector: string): string =>
  css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";

describe("卡片栅格：单条目不撑满整行", () => {
  it("卡片类栅格使用 auto-fill 保留空轨道", () => {
    const css = read("src/app/globals.css");
    for (const selector of [".card-grid", ".video-grid", ".tpl-grid", ".pick-grid"]) {
      const rule = ruleOf(css, selector);
      assert.match(rule, /repeat\(auto-fill,/, `${selector} 应使用 auto-fill`);
      assert.doesNotMatch(rule, /repeat\(auto-fit,/, `${selector} 不应使用 auto-fit`);
    }
  });

  it("数量固定的表单字段与统计卡仍用 auto-fit", () => {
    const css = read("src/app/globals.css");
    for (const selector of [".form-grid", ".stat-row"]) {
      assert.match(ruleOf(css, selector), /repeat\(auto-fit,/);
    }
  });
});

describe("骨架屏不再产生抖动条", () => {
  it("骨架线是静态占位，无 shimmer 位移动画", () => {
    const css = read("src/app/globals.css");
    assert.doesNotMatch(css, /@keyframes shimmer/);
    const line = ruleOf(css, "\\.skeleton-line");
    assert.doesNotMatch(line, /animation/);
    assert.match(ruleOf(css, "\\.skeleton"), /min-height/);
  });

  it("Skeleton 组件挂载稳定高度容器", () => {
    assert.match(
      read("src/components/ui.tsx"),
      /className="skeleton"[^>]*aria-busy/
    );
  });

  it("缓存回填在 paint 前完成，避免 SSR 骨架闪现", () => {
    const hooks = read("src/lib/client/hooks.ts");
    assert.match(hooks, /typeof window !== "undefined" \? useLayoutEffect : useEffect/);
    assert.match(hooks, /useIsomorphicLayoutEffect\(\(\) => \{/);
    assert.match(hooks, /readCacheEntry<T>\(cacheKey, staleMs\)/);
    // 轮询仍走普通 effect，不受 layout effect 改造影响。
    assert.match(hooks, /export function usePolling[\s\S]*useEffect\(\(\) => \{/);
  });

  it("滚动条槽位固定，避免内容高度变化引起横向抖动", () => {
    assert.match(read("src/app/globals.css"), /html\s*\{[^}]*scrollbar-gutter:\s*stable/);
  });
});
