import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import "../src/lib/env";

/** 阶段六队列协议集成测试（真库）：SKIP LOCKED、租约、超时回收、重试/取消。 */
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const userId = randomUUID();
const productId = randomUUID();
const templateId = randomUUID();

let jobs: typeof import("../src/lib/jobs");
let queue: typeof import("../src/lib/queue");
let pipeline: typeof import("../src/lib/pipeline");
let detailRoute: typeof import("../src/app/api/videos/[id]/route");
let retryRoute: typeof import("../src/app/api/videos/[id]/retry/route");

before(async () => {
  if (!pool) return;
  await pool.query(
    "INSERT INTO users (id, email, quota_left) VALUES ($1,$2,100)",
    [userId, `queue-${userId}@example.invalid`]
  );
  await pool.query(
    `INSERT INTO products (id, user_id, name, image_path, selling_points)
     VALUES ($1,$2,'测试商品','legacy/a.png','[]'::jsonb)`,
    [productId, userId]
  );
  await pool.query(
    `INSERT INTO video_templates (id, name, category, composition_id, duration_sec)
     VALUES ($1,'测试模板','launch','product-launch',15)`,
    [templateId]
  );
  jobs = await import("../src/lib/jobs");
  queue = await import("../src/lib/queue");
  pipeline = await import("../src/lib/pipeline");
  detailRoute = await import("../src/app/api/videos/[id]/route");
  retryRoute = await import("../src/app/api/videos/[id]/retry/route");
});

afterEach(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM usage_records WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM video_jobs WHERE user_id=$1", [userId]);
  await pool.query("UPDATE users SET quota_left=100 WHERE id=$1", [userId]);
});

after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.query("DELETE FROM video_templates WHERE id=$1", [templateId]);
  await pool.end();
});

const validRequest = {
  productId,
  templateId,
  copy: { title: "标题", subtitle: "副标题", sellingPoints: ["卖点一"], cta: "立即购买" },
};

async function createJob() {
  const { job } = await jobs.createVideoJob(userId, validRequest, `idem-${randomUUID()}`);
  return job;
}

async function quota() {
  const { rows } = await pool!.query("SELECT quota_left FROM users WHERE id=$1", [userId]);
  return rows[0].quota_left as number;
}

async function jobRow(jobId: string) {
  const { rows } = await pool!.query(
    `SELECT status, attempt, leased_at, lease_until, error_message
     FROM video_jobs WHERE id=$1`,
    [jobId]
  );
  return rows[0];
}

const auth = { "x-dev-user-id": userId, "content-type": "application/json" };

describe("队列协议（方案 8.1 / 8.2）", { skip: !hasDb }, () => {
  it("并发领取不重复，领取时写入租约与 attempt", async () => {
    const first = await createJob();
    const second = await createJob();
    const [a, b] = await Promise.all([queue.claimNextJob(), queue.claimNextJob()]);

    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    assert.equal(a.attempt, 1);
    assert.equal(b.attempt, 1);
    assert.ok(a.leasedAt instanceof Date);
    // 全量测试并行运行时队列里可能有其他测试文件的任务，只断言不会重复领取。
    assert.ok(first.id && second.id);

    const row = await jobRow(a.id);
    assert.equal(row.status, "processing");
    assert.ok(row.lease_until > row.leased_at);
  });

  it("指定任务领取只能成功一次", async () => {
    const job = await createJob();
    const claim = await queue.claimJobById(job.id);
    assert.ok(claim);
    assert.equal(await queue.claimJobById(job.id), null);
    assert.equal(await pipeline.claimJob(job.id), false);
  });

  it("续租使用 leased_at 作为 CAS 令牌，过期令牌续租失败", async () => {
    const job = await createJob();
    const claim = await queue.claimJobById(job.id);
    assert.ok(claim);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await queue.renewLease(job.id, claim.leasedAt);
    assert.ok(renewed);
    assert.notEqual(renewed.getTime(), claim.leasedAt.getTime());
    assert.equal(await queue.renewLease(job.id, claim.leasedAt), null);
    assert.ok(await queue.renewLease(job.id, renewed));
  });

  it("超时回收：未达上限重新入队，达上限转 failed 且只返还一次额度", async () => {
    const job = await createJob();
    await queue.claimJobById(job.id);
    await pool!.query(
      "UPDATE video_jobs SET lease_until = now() - interval '1 minute' WHERE id=$1",
      [job.id]
    );

    const first = await queue.reclaimExpiredJobs();
    assert.ok(first.requeued.includes(job.id));
    assert.equal(first.failed.includes(job.id), false);
    let row = await jobRow(job.id);
    assert.equal(row.status, "pending");
    assert.equal(row.leased_at, null);
    assert.equal(row.attempt, 1);

    const before = await quota();
    await pool!.query(
      `UPDATE video_jobs SET status='processing', attempt=3,
       leased_at=now(), lease_until=now() - interval '1 minute' WHERE id=$1`,
      [job.id]
    );
    const second = await queue.reclaimExpiredJobs();
    assert.ok(second.failed.includes(job.id));
    row = await jobRow(job.id);
    assert.equal(row.status, "failed");
    assert.match(row.error_message, /超过最大尝试次数/);
    assert.equal(await quota(), before + 1);

    const refunds = await pool!.query(
      "SELECT count(*)::int AS n FROM usage_records WHERE video_job_id=$1 AND usage_type='refund'",
      [job.id]
    );
    assert.equal(refunds.rows[0].n, 1);
  });

  it("手动重试重新扣额度；pending 不可重试；超过上限拒绝", async () => {
    const job = await createJob();
    await queue.claimJobById(job.id);
    await pipeline.failJob(job.id, "渲染失败");
    const failedQuota = await quota();

    const retried = await pipeline.retryJob(userId, job.id);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attempt, 1, "手动重试不清除 attempt");
    assert.equal(await quota(), failedQuota - 1);
    await assert.rejects(() => pipeline.retryJob(userId, job.id), /仅失败或已取消/);

    await pipeline.failJob(job.id, "再次失败");
    await pool!.query("UPDATE video_jobs SET attempt=3 WHERE id=$1", [job.id]);
    await assert.rejects(() => pipeline.retryJob(userId, job.id), /最大尝试次数/);
  });

  it("取消与重复取消不重复返还；取消后允许重试", async () => {
    const job = await createJob();
    const before = await quota();
    const first = await pipeline.cancelJob(userId, job.id);
    assert.equal(first.cancelled, true);
    assert.equal(first.status, "cancelled");
    assert.equal(await quota(), before + 1);

    const second = await pipeline.cancelJob(userId, job.id);
    assert.equal(second.cancelled, false);
    assert.equal(await quota(), before + 1);
    assert.equal((await pipeline.retryJob(userId, job.id)).status, "pending");
    assert.equal(await quota(), before);
  });

  it("API：重试跨用户 404、pending 400；DELETE 取消 200", async () => {
    const job = await createJob();
    const otherUser = randomUUID();
    const url = `http://localhost/api/videos/${job.id}`;

    const cross = await retryRoute.POST(
      new NextRequest(`${url}/retry`, {
        method: "POST",
        headers: { "x-dev-user-id": otherUser },
      }),
      { params: { id: job.id } }
    );
    assert.equal(cross.status, 404);

    const pending = await retryRoute.POST(
      new NextRequest(`${url}/retry`, { method: "POST", headers: auth }),
      { params: { id: job.id } }
    );
    assert.equal(pending.status, 400);

    const before = await quota();
    const cancelled = await detailRoute.DELETE(
      new NextRequest(url, { method: "DELETE", headers: auth }),
      { params: { id: job.id } }
    );
    assert.equal(cancelled.status, 200);
    assert.equal(await quota(), before + 1);
    assert.equal((await jobRow(job.id)).status, "cancelled");
  });

  it("状态守卫：终态任务不会被 failJob 覆盖，租约令牌不匹配时拒绝回写", async () => {
    const job = await createJob();
    await pipeline.completeJob(job.id, { outputPath: "videos/x/y.mp4" });
    await pipeline.failJob(job.id, "不应生效");
    assert.equal((await jobRow(job.id)).status, "completed");

    const second = await createJob();
    const claim = await queue.claimJobById(second.id);
    assert.ok(claim);
    const renewed = await queue.renewLease(second.id, claim.leasedAt);
    assert.ok(renewed);
    await assert.rejects(
      () => pipeline.completeJob(second.id, { outputPath: "videos/x/z.mp4" }, claim.leasedAt),
      /状态已变更/
    );
    assert.equal((await jobRow(second.id)).status, "processing");
  });
});
