/**
 * UI 审核整改的静态回归守卫：把 P0/P1/P2 的关键修复点固化成断言。
 * 纯文本/结构检查，不需要启动服务或数据库，适合放进 CI 门禁。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const PAGES = [
  "src/app/(app)/page.tsx",
  "src/app/(app)/create/page.tsx",
  "src/app/(app)/products/page.tsx",
  "src/app/(app)/templates/page.tsx",
  "src/app/(app)/videos/page.tsx",
  "src/app/login/page.tsx",
];

describe("P0：阻断项修复守卫", () => {
  it("P0-1 窄屏顶部导航与 skip-link 存在，两处导航共用 NAV", () => {
    const shell = read("src/components/AppShell.tsx");
    assert.match(shell, /const NAV = \[/);
    assert.match(shell, /className="skip-link" href="#main-content"/);
    assert.match(shell, /className="top-nav-bar"/);
    assert.match(shell, /id="main-content"/);
    assert.match(shell, /const navItems = (?:NAV|allNav)\.map/); // V1.0：管理员入口并入 allNav 后共用同一份判定
    const navCount = (shell.match(/aria-label="主导航"/g) ?? []).length;
    assert.equal(navCount, 2, "侧栏与顶部条应各有一份主导航");
  });

  it("P0-3 / A-04 图标按钮 44px 且相邻热区间距 ≥8px", () => {
    const css = read("src/app/globals.css");
    assert.match(css, /\.icon-btn\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
    assert.match(css, /\.vrow \.ops\s*\{[^}]*gap:\s*8px/);
  });

  it("P0-4 Modal 具备初始焦点、Tab 循环、Esc 与焦点恢复", () => {
    const ui = read("src/components/ui.tsx");
    assert.match(ui, /aria-modal="true"/);
    assert.match(ui, /createPortal/);
    assert.match(ui, /setAttribute\("inert"/);
    assert.match(ui, /previouslyFocused/);
    assert.match(ui, /event\.key === "Escape"/);
    assert.match(ui, /event\.shiftKey/);
    assert.match(ui, /focusableIn/);
  });
});

describe("P1：主要差距修复守卫", () => {
  it("P1-2 创作页预览在移动端折叠为 tablist 双标签", () => {
    const create = read("src/app/(app)/create/page.tsx");
    assert.match(create, /SegmentedTabs/);
    assert.match(create, /data-hidden=\{mobileTab !== "form"\}/);
    assert.match(create, /data-hidden=\{mobileTab !== "preview"\}/);
    assert.match(create, /useState<"form" \| "preview">\("form"\)/, "预览应默认收起");
    const ui = read("src/components/ui.tsx");
    assert.match(ui, /role="tablist"/);
    assert.match(ui, /aria-selected/);
    assert.match(ui, /ArrowLeft/);
  });

  it("P1-3 / C-06 completed 新建、failed/cancelled 重试，两条后端路径分开", () => {
    const videos = read("src/app/(app)/videos/page.tsx");
    // 验收 P1-02/03：不再用 (failed || completed) 一把梭，
    // cancelled 也要有入口，达到 attempt 上限的任务不再显示必然被拒的按钮。
    assert.match(videos, /canRetry/);
    assert.match(videos, /MAX_JOB_ATTEMPTS/);
    assert.match(videos, /job\.status === "cancelled"/);
    assert.match(videos, /\/regenerate/);
    assert.match(videos, /\/retry/);
    assert.match(videos, /idempotencyKey: newIdempotencyKey\(\)/);
    const route = read("src/app/api/videos/[id]/regenerate/route.ts");
    assert.match(route, /regenerateFromCompletedJob/);
    const jobs = read("src/lib/jobs.ts");
    assert.match(jobs, /input_json 快照|RenderJobInputSchema\.parse\(source\.inputJson\)/);
  });

  it("P1-4 上传即时校验、本地预览、进度与字段级错误齐全", () => {
    const products = read("src/app/(app)/products/page.tsx");
    assert.match(products, /validateImageFile/);
    assert.match(products, /URL\.createObjectURL/);
    assert.match(products, /URL\.revokeObjectURL/);
    assert.match(products, /uploadWithProgress/);
    assert.match(products, /role="progressbar"/);
    assert.match(products, /className="hint err"/);
    assert.match(products, /aria-describedby=/);
  });

  it("P1-5 全站无原生 window.confirm，统一走 ConfirmDialog", () => {
    for (const page of PAGES) {
      assert.doesNotMatch(read(page), /window\.confirm/, `${page} 仍有原生 confirm`);
    }
    const ui = read("src/components/ui.tsx");
    assert.match(ui, /export function ConfirmDialog/);
    assert.match(read("src/app/(app)/products/page.tsx"), /ConfirmDialog/);
    assert.match(read("src/app/(app)/videos/page.tsx"), /ConfirmDialog/);
  });

  it("P1-6 / M1 模板卡不再渲染内部 compositionId，展示名与 CTA 由 DB 下发", () => {
    const templates = read("src/app/(app)/templates/page.tsx");
    assert.doesNotMatch(templates, /compositionId\.replace/);
    assert.match(templates, /displayFor\(template\)/); // V1.0：从 DB DTO 取，不再按 id 查硬编码映射
    assert.match(templates, /display\.englishName/);
    assert.match(templates, /display\.cta/);
    const route = read("src/app/api/templates/route.ts");
    assert.match(route, /const englishName = row\.englishName \|\| NEUTRAL\.englishName/);
    assert.match(route, /const cta = row\.cta \|\| NEUTRAL\.cta/);
    assert.doesNotMatch(route, /const DISPLAY/); // M1：删除硬编码 DISPLAY 常量
    const mapping = read("src/lib/client/template-display.ts");
    assert.match(mapping, /中性展示名兜底|neutral/i); // 未知模板用中性兜底，绝不回退 id
    assert.doesNotMatch(mapping, /TEMPLATE_DISPLAY/); // 删除硬编码映射
  });
});

describe("P2：体验与文案修复守卫", () => {
  it("P2-1 登录页不再向用户暴露开发实现说明", () => {
    assert.doesNotMatch(read("src/app/login/page.tsx"), /本地开发会话/);
  });

  it("P2-2 侧栏与边界卡不再展示假套餐/禁用升级入口", () => {
    assert.doesNotMatch(read("src/components/AppShell.tsx"), /Studio Plan/);
    for (const page of ["src/app/(app)/page.tsx", "src/app/(app)/create/page.tsx"]) {
      assert.doesNotMatch(read(page), /disabled>升级/, `${page} 仍有禁用升级占位`);
    }
  });

  it("P2-3 成功率无样本显示「—」并标注统计口径", () => {
    const dashboard = read("src/app/(app)/page.tsx");
    assert.match(dashboard, /successRate === null \? "—"/);
    assert.match(dashboard, /按已终结任务统计/);
    assert.doesNotMatch(dashboard, /\? Math\.round\(\(completed \/ \(completed \+ failed\)\) \* 100\) : 100/);
  });

  it("P2-4 / P2-5 视频页加载与逐任务进度文案", () => {
    const videos = read("src/app/(app)/videos/page.tsx");
    assert.match(videos, /视频加载中…/);
    assert.match(videos, /正在生成 MP4…/);
  });

  it("P2-6 不再宣称 CSS 静态预览与成片同源", () => {
    assert.doesNotMatch(read("src/app/(app)/create/page.tsx"), /预览与成片同源/);
  });

  it("P2-7 错误 Toast 使用 role=alert", () => {
    assert.match(read("src/components/Toaster.tsx"), /role=\{item\.error \? "alert" : "status"\}/);
  });

  it("P2-8 字体文件已落地到 public/fonts", () => {
    assert.ok(existsSync(path.join(root, "public/fonts/fraunces-latin-var.woff2")));
    assert.ok(existsSync(path.join(root, "public/fonts/plus-jakarta-sans-latin-var.woff2")));
  });
});

describe("基准冲突：可落地项", () => {
  it("C-03 终态视频删除入口与后端 purge 分支存在", () => {
    assert.match(read("src/app/(app)/videos/page.tsx"), /purge=1/);
    assert.match(read("src/app/api/videos/[id]/route.ts"), /deleteFinishedJob/);
    assert.match(read("src/lib/job-state.ts"), /usageRecord\.updateMany/);
  });

  it("C-05 UI 原型已按规范条款修正（44px + 窄屏顶部导航）", () => {
    // 原 docs/ui/ProductVideo_AI_UI设计方案.html 已不在仓库；现行原型在 docs/ui-design/。
    const design = read("docs/ui-design/ProductVideo_AI_模板管理_UI原型_V1.0.html");
    assert.doesNotMatch(design, /\.icon-btn\{width:30px/);
    assert.match(design, /\.icon-btn\{width:44px/);
    // 窄屏顶部导航类名由 app-topnav 演进为 top-nav-bar，两者都是等价实现。
    assert.match(design, /\.top-nav-bar\{/);
    assert.match(design, /@media \(max-width:1023px\)/);
    assert.doesNotMatch(design, /min-height:38px/);
  });
});
