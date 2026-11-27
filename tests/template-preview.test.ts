/**
 * 模板选择页预览功能的静态回归守卫：
 * 1) 页面接入常驻预览面板与悬停预览，且保留单选卡片组的键盘语义；
 * 2) 播放器不再写死 480×854，可随容器宽度按 9:16 缩放；
 * 3) 4 套模板都带可通过 Props 契约校验的演示数据；
 * 4) 悬停预览尊重系统「减少动效」，且不自动抢占首屏加载。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { TEMPLATES, previewFor } from "../src/shared/template.schema";
import { ProductVideoPropsSchema } from "../src/shared/video-props.schema";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("模板选择页：预览功能", () => {
  it("页面同时具备常驻预览面板、悬停预览与原有 radiogroup 语义", () => {
    const page = read("src/app/(app)/templates/page.tsx");
    assert.match(page, /<TemplatePreviewPanel/);
    assert.match(page, /className="tpl-hover" aria-hidden="true"/);
    assert.match(page, /<VideoPreviewClient[\s\S]{0,200}autoPlay[\s\S]{0,80}controls=\{false\}/);
    assert.match(page, /role="radiogroup"/);
    assert.match(page, /aria-checked=\{isActive\}/);
  });

  it("悬停预览延迟触发、选中卡不重复叠加、尊重减少动效", () => {
    const page = read("src/app/(app)/templates/page.tsx");
    assert.match(page, /HOVER_PREVIEW_DELAY_MS = 200/);
    assert.match(page, /template\.id === activeId/);
    assert.match(page, /usePrefersReducedMotion\(\)/);
    assert.match(page, /hovered === template\.id && !isActive && previewReady/);
    const hooks = read("src/lib/client/hooks.ts");
    assert.match(hooks, /prefers-reduced-motion: reduce/);
    assert.match(hooks, /requestIdleCallback/);
  });

  it("播放器只指定宽度时按 9:16 自适应，不再写死高度", () => {
    const preview = read("src/components/VideoPreview.tsx");
    assert.match(preview, /style\?\.width !== undefined && style\.height === undefined/);
    const client = read("src/components/VideoPreviewClient.tsx");
    assert.match(client, /aspectRatio: "9 \/ 16"/);
    // 外框宽度常量就地定义，避免为了取一个数字把播放器打进首包。
    assert.doesNotMatch(client, /from "\.\/VideoPreview"/);
  });

  it("面板播放器不抢焦点：关闭空格键播放/暂停，避免方向键切换后焦点落到播放按钮", () => {
    const panel = read("src/components/TemplatePreviewPanel.tsx");
    assert.match(panel, /spaceKeyToPlayOrPause: false/);
    const preview = read("src/components/VideoPreview.tsx");
    assert.match(preview, /spaceKeyToPlayOrPause=\{controls && spaceKeyToPlayOrPause\}/);
  });

  it("4 套模板都有合法的演示数据，未注册 id 返回 null", () => {
    assert.equal(TEMPLATES.length, 4);
    for (const template of TEMPLATES) {
      const parsed = ProductVideoPropsSchema.safeParse(template.sampleProps);
      assert.ok(parsed.success, `${template.id} 的 sampleProps 不符合契约: ${parsed.error?.message}`);
      assert.match(template.sampleProps.brandColor, /^#[0-9a-fA-F]{6}$/);
      assert.notEqual(template.sampleProps.imageUrl, template.defaultProps.imageUrl, `${template.id} 应使用示例商品图`);
      const target = previewFor(template.id);
      assert.ok(target, `${template.id} 应可预览`);
      assert.equal(target.compositionId, template.id);
    }
    assert.equal(previewFor("not-a-template"), null);
  });
});
