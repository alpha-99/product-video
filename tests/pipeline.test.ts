import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import "../src/lib/env";

/**
 * 阶段四链路集成测试（真库，隔离测试数据）。
 *
 * 无 DATABASE_URL 时整组跳过；有库时创建随机测试 user/product/template，
 * 测试后按 user_id 级联清理，绝不触碰真实业务数据。
 * 渲染耗时部分不在此测试，交由 E2E 手动验证。
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

const userId = randomUUID();
const productId = randomUUID();
const templateId = "11111111-1111-4111-8111-111111111111"; // §6.2.1 方案 A：复用种子行
const email = `pipeline-test-${userId}@example.invalid`;

let jobs: typeof import("../src/lib/jobs");
let pipeline: typeof import("../src/lib/pipeline");
let errors: typeof import("../src/lib/errors");

before(async () => {
  if (!pool) return;
  // 额度设大，避免多个测试共享同一用户时相互耗尽；额度不足测试单独清零。
  await pool.query("INSERT INTO users (id, email, quota_left) VALUES ($1,$2,100)", [userId, email]);
  await pool.query(
    `INSERT INTO products (id, user_id, name, image_path, selling_points)
     VALUES ($1,$2,'测试商品','uploads/test.png','[]'::jsonb)`,
    [productId, userId]
  );
  // §6.2.1 方案 A：复用种子模板行，不再插入临时模板（避免 UNIQUE 冲突）。
  jobs = await import("../src/lib/jobs");
  pipeline = await import("../src/lib/pipeline");
  errors = await import("../src/lib/errors");
});

after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  // 种子模板行保留（方案 A）
  await pool.end();
});

import type { CreateVideoRequest } from "../src/shared/api";
const validRequest: CreateVideoRequest = {
  productId,
  templateId,
  copy: {
    title: "标题",
    subtitle: "副标题",
    sellingPoints: ["卖点一"],
    cta: "立即购买",
  },
};

describe("任务提交链路（方案 5.2 / 8.3）", { skip: !hasDb }, () => {
  it("幂等键命中时返回既有任务，不重复扣额度", async () => {
    const key = `idem-${randomUUID()}`;
    const quotaBefore = await pool!.query("SELECT quota_left FROM users WHERE id=$1", [userId]);
    const first = await jobs.createVideoJob(userId, validRequest, key);
    assert.equal(first.created, true);
    assert.equal(first.job.status, "pending");

    const second = await jobs.createVideoJob(userId, validRequest, key);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);

    const quota = await pool!.query("SELECT quota_left FROM users WHERE id=$1", [userId]);
    assert.equal(quota.rows[0].quota_left, quotaBefore.rows[0].quota_left - 1, "幂等提交只扣 1 次额度");

    const usage = await pool!.query(
      "SELECT count(*)::int AS n FROM usage_records WHERE user_id=$1 AND usage_type='consume'",
      [userId]
    );
    assert.equal(usage.rows[0].n, 1);
  });

  it("input_json 快照含合法 RenderJobInput，compositionId 来自模板表", async () => {
    const key = `idem-${randomUUID()}`;
    const { job } = await jobs.createVideoJob(userId, validRequest, key);
    const snapshot = job.inputJson as { jobId: string; userId: string; compositionId: string; props: unknown };
    assert.equal(snapshot.jobId, job.id);
    assert.equal(snapshot.userId, userId);
    assert.equal(snapshot.compositionId, "product-launch");
    assert.ok(snapshot.props && typeof snapshot.props === "object");
  });

  it("额度不足抛 QUOTA_EXCEEDED，不建任务不写用量", async () => {
    // 把额度清零
    await pool!.query("UPDATE users SET quota_left=0 WHERE id=$1", [userId]);
    try {
      await assert.rejects(
        jobs.createVideoJob(userId, validRequest, `idem-${randomUUID()}`),
        (err: unknown) => err instanceof errors.DomainError && err.code === "QUOTA_EXCEEDED"
      );
    } finally {
      await pool!.query("UPDATE users SET quota_left=100 WHERE id=$1", [userId]);
    }
  });

  it("跨用户商品被拒绝（归属校验）", async () => {
    const otherProduct = randomUUID();
    await assert.rejects(
      jobs.createVideoJob(
        userId,
        { ...validRequest, productId: otherProduct },
        `idem-${randomUUID()}`
      ),
      (err: unknown) => err instanceof errors.DomainError && err.code === "NOT_FOUND"
    );
  });
});

describe("链路处理状态守卫与失败返还（方案 8.3）", { skip: !hasDb }, () => {
  it("claimJob 只领取一次，重复领取返回 false", async () => {
    const { job } = await jobs.createVideoJob(userId, validRequest, `idem-${randomUUID()}`);
    assert.equal(await pipeline.claimJob(job.id), true);
    assert.equal(await pipeline.claimJob(job.id), false);
  });

  it("failJob 回写 failed、返还额度且只返还一次", async () => {
    const { job } = await jobs.createVideoJob(userId, validRequest, `idem-${randomUUID()}`);
    await pipeline.claimJob(job.id);

    const before = await pool!.query("SELECT quota_left FROM users WHERE id=$1", [userId]);
    await pipeline.failJob(job.id, "模拟渲染失败");
    await pipeline.failJob(job.id, "重复调用"); // 第二次不应再返还

    const after = await pool!.query("SELECT quota_left FROM users WHERE id=$1", [userId]);
    assert.equal(after.rows[0].quota_left, before.rows[0].quota_left + 1);

    const row = await pool!.query("SELECT status, error_message FROM video_jobs WHERE id=$1", [job.id]);
    assert.equal(row.rows[0].status, "failed");
    assert.equal(row.rows[0].error_message, "模拟渲染失败");

    const refunds = await pool!.query(
      "SELECT count(*)::int AS n FROM usage_records WHERE video_job_id=$1 AND usage_type='refund'",
      [job.id]
    );
    assert.equal(refunds.rows[0].n, 1);
  });

  it("completed 任务不会被 failJob 覆盖", async () => {
    const { job } = await jobs.createVideoJob(userId, validRequest, `idem-${randomUUID()}`);
    await pipeline.completeJob(job.id, { outputPath: "videos/x/y.mp4" });
    await pipeline.failJob(job.id, "不应生效");
    const row = await pool!.query("SELECT status FROM video_jobs WHERE id=$1", [job.id]);
    assert.equal(row.rows[0].status, "completed");
  });
});
