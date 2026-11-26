import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { RenderJobInputSchema } from "../src/shared/render.schema";
import type { ProductVideoProps } from "../src/shared/video-props.schema";

type RendererModule = {
  resolveDataPath(relativePath: string): string;
  resolveAssetForRender(src: string): Promise<string>;
  prepareInputProps(props: ProductVideoProps): Promise<ProductVideoProps>;
  withRenderLock<T>(fn: () => Promise<T>): Promise<T>;
};

const TEST_ROOT = path.join(os.tmpdir(), `pv-render-test-${Date.now()}`);

let renderer: RendererModule;

before(async () => {
  process.env.STORAGE_ROOT = TEST_ROOT;
  renderer = (await import("../src/lib/renderer")) as RendererModule;
});

describe("渲染输入契约（方案 7.2）", () => {
  const validInput = {
    jobId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    compositionId: "product-launch",
    props: {
      title: "新品",
      subtitle: "副标题",
      imageUrl: "data:image/svg+xml;base64,AA==",
      sellingPoints: ["卖点"],
      cta: "立即购买",
      brandColor: "#2563eb",
    },
  };

  it("合法 input.json 通过，缺字段与非法模板被拒绝", () => {
    assert.equal(RenderJobInputSchema.safeParse(validInput).success, true);
    assert.equal(
      RenderJobInputSchema.safeParse({ ...validInput, compositionId: "unknown" }).success,
      false
    );
    assert.equal(
      RenderJobInputSchema.safeParse({ ...validInput, jobId: "not-a-uuid" }).success,
      false
    );
  });
});

describe("渲染路径安全与素材解析", () => {
  it("拒绝绝对路径与 .. 穿越，合法相对路径解析到数据根目录", () => {
    assert.throws(() => renderer.resolveDataPath("/etc/passwd"), /非法相对路径/);
    assert.throws(() => renderer.resolveDataPath("videos/../secret"), /非法相对路径/);
    assert.equal(
      renderer.resolveDataPath("videos/u1/j1.mp4"),
      path.join(TEST_ROOT, "videos", "u1", "j1.mp4")
    );
  });

  it("受控 data URL 与 uploads 相对路径可用，外部/本地协议一律拒绝", async () => {
    assert.equal(
      await renderer.resolveAssetForRender("data:image/png;base64,AA=="),
      "data:image/png;base64,AA=="
    );
    // 验收 P1-08：这些地址曾原样透传给 Remotion Chromium，形成 SSRF 请求面。
    for (const untrusted of [
      "https://example.com/a.png",
      "http://127.0.0.1:8080/admin",
      "file:///etc/passwd",
      "blob:https://example.com/uuid",
      "//evil.example/a.png",
      "/etc/passwd",
      "uploads/../secret.png",
      "videos/u1/j1.mp4",
    ]) {
      await assert.rejects(
        () => renderer.resolveAssetForRender(untrusted),
        /不受信任/,
        untrusted
      );
    }

    const rel = "uploads/u1/product.svg";
    const abs = renderer.resolveDataPath(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    const dataUrl = await renderer.resolveAssetForRender(rel);
    assert.match(dataUrl, /^data:image\/svg\+xml;base64,/);
  });

  it("prepareInputProps 只转换图片字段，其余参数保持不变", async () => {
    const props = {
      title: "标题",
      subtitle: "副标题",
      imageUrl: "data:image/png;base64,AA==",
      price: "29.99",
      sellingPoints: ["卖点"],
      cta: "购买",
      brandColor: "#123456",
      musicPath: "audio/bgm.mp3",
    };
    const prepared = await renderer.prepareInputProps(props);
    assert.equal(prepared.imageUrl, props.imageUrl);
    assert.equal(prepared.price, "29.99");
    assert.equal(prepared.musicPath, "audio/bgm.mp3");
  });
});

describe("单任务串行锁", () => {
  it("后一个任务必须等前一个完成才开始", async () => {
    const events: string[] = [];
    const makeTask = (name: string, delay: number) => async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`${name}:end`);
      return name;
    };

    const results = await Promise.all([
      renderer.withRenderLock(makeTask("A", 30)),
      renderer.withRenderLock(makeTask("B", 5)),
    ]);
    assert.deepEqual(results, ["A", "B"]);
    assert.deepEqual(events, ["A:start", "A:end", "B:start", "B:end"]);
  });
});
