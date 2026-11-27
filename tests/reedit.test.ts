/**
 * 失败 / 已取消任务「重新编辑」守卫。
 *
 * 两条路径分开验证：
 * 1) draftFromJob 纯函数：快照 → 创作页草稿的反解与脏数据兜底；
 * 2) 静态源码断言：视频管理页入口 + 创作页 ?from= 恢复链路仍在，
 *    且不绕过标准 POST /api/videos 的商品归属与参数校验。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { draftFromJob } from "../src/lib/client/job-draft";
import type { VideoJobDto } from "../src/lib/client/types";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function madeJob(overrides: Partial<VideoJobDto> = {}): VideoJobDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    productId: "33333333-3333-4333-8333-333333333333",
    templateId: "44444444-4444-4444-8444-444444444444",
    status: "failed",
    inputJson: {
      jobId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      compositionId: "product-launch",
      props: {
        title: "云感保温杯",
        subtitle: "新品首发 · 轻装出行",
        imageUrl: "uploads/user/p/product.png",
        sellingPoints: ["12 小时锁温", "仅 280g", "一键开合"],
        cta: "了解新品",
        brandColor: "#0f766e",
      },
    },
    outputPath: null,
    thumbnailPath: null,
    errorMessage: "write EPIPE",
    attempt: 3,
    idempotencyKey: "idem-key",
    createdAt: "2026-11-27T00:00:00.000Z",
    completedAt: "2026-11-27T00:01:00.000Z",
    ...overrides,
  };
}

describe("失败任务快照 → 创作页草稿", () => {
  it("完整快照回填文案 / 品牌色 / 商品与模板 id", () => {
    const draft = draftFromJob(madeJob());
    assert.ok(draft);
    assert.equal(draft.productId, "33333333-3333-4333-8333-333333333333");
    assert.equal(draft.templateId, "44444444-4444-4444-8444-444444444444");
    assert.deepEqual(draft.copy, {
      title: "云感保温杯",
      subtitle: "新品首发 · 轻装出行",
      sellingPoints: ["12 小时锁温", "仅 280g", "一键开合"],
      cta: "了解新品",
    });
    assert.equal(draft.pointsText, "12 小时锁温 · 仅 280g · 一键开合");
    assert.equal(draft.brandColor, "#0f766e");
    assert.deepEqual(draft.droppedAdvanced, []);
  });

  it("快照缺失、字段不合法时返回 null，绝不产出半截草稿", () => {
    assert.equal(draftFromJob(null), null);
    assert.equal(draftFromJob(madeJob({ inputJson: null })), null);
    assert.equal(draftFromJob(madeJob({ productId: "" })), null);
    assert.equal(
      draftFromJob(
        madeJob({
          inputJson: {
            ...madeJob().inputJson!,
            props: { ...madeJob().inputJson!.props, title: "  " },
          },
        })
      ),
      null
    );
    assert.equal(
      draftFromJob(
        madeJob({
          inputJson: {
            ...madeJob().inputJson!,
            props: { ...madeJob().inputJson!.props, sellingPoints: ["", "  "] },
          },
        })
      ),
      null
    );
    assert.equal(
      draftFromJob(
        madeJob({
          inputJson: {
            ...madeJob().inputJson!,
            props: { ...madeJob().inputJson!.props, brandColor: "red" },
          },
        })
      ),
      null
    );
  });

  it("本期未开放的高级参数被标记，回填后界面可提示会丢失", () => {
    const draft = draftFromJob(
      madeJob({
        inputJson: {
          ...madeJob().inputJson!,
          props: {
            ...madeJob().inputJson!.props,
            logoPath: "uploads/user/p/logo.png",
            discountText: "限时 8 折",
          },
        },
      })
    );
    assert.ok(draft);
    assert.deepEqual(draft.droppedAdvanced, ["品牌 Logo", "促销文案"]);
  });

  it("空白卖点被剔除，保留合法项", () => {
    const draft = draftFromJob(
      madeJob({
        inputJson: {
          ...madeJob().inputJson!,
          props: { ...madeJob().inputJson!.props, sellingPoints: ["有效卖点", "   "] },
        },
      })
    );
    assert.ok(draft);
    assert.deepEqual(draft.copy.sellingPoints, ["有效卖点"]);
  });
});

describe("重新编辑入口与链路的静态守卫", () => {
  it("视频管理页：失败/取消均可重新编辑，且不受 attempt 上限约束", () => {
    const source = read("src/app/(app)/videos/page.tsx");
    assert.match(source, /useRouter/);
    assert.match(source, /canReedit = failed \|\| cancelled/);
    assert.match(source, /\/create\?from=/);
    // 既有两条后端路径的守卫不能因为新增入口而丢失。
    assert.match(source, /canRetry/);
    assert.match(source, /MAX_JOB_ATTEMPTS/);
    assert.match(source, /\/regenerate/);
    assert.match(source, /\/retry/);
    assert.match(source, /重新编辑/);
  });

  it("创作页：从任务详情恢复草稿，且不绕过标准提交校验", () => {
    const source = read("src/app/(app)/create/page.tsx");
    assert.match(source, /params\.get\("from"\)/);
    assert.match(source, /draftFromJob/);
    assert.match(source, /api\.get<VideoJobDto>\(/);
    assert.match(source, /reeditInvalid/);
    assert.match(source, /setProductId\(draft\.productId\)/);
    assert.match(source, /setTemplateId\(draft\.templateId\)/);
    // 提交仍走标准接口，由 createVideoJob 完整校验。
    assert.match(source, /api\.post<CreateVideoResult>\(\s*"\/api\/videos"/);
  });

  it("前端 DTO 与纯函数不引入服务端依赖", () => {
    const source = read("src/lib/client/job-draft.ts");
    assert.doesNotMatch(source, /from "\.\.\/db"|@prisma/);
    assert.match(source, /export function draftFromJob/);
  });
});
