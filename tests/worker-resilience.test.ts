/**
 * Worker 长驻稳定性回归：
 * 1) Remotion 内部 ffmpeg 写帧的 EPIPE 属于未 await 的 Promise 异常，
 *    必须由入口兜住，否则 Node 直接终止进程；
 * 2) Supavisor session pool 上限约 15，单进程 Prisma 默认 9 连接会互相挤爆；
 * 3) 历史快照的公共占位图要能渲染，且被拒素材的错误要带字段名与值。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { prismaUrl } from "../src/lib/db";
import { resolveAssetForRender } from "../src/lib/renderer";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

function withDatabaseUrl<T>(value: string, fn: () => T): T {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

describe("Worker 长驻：渲染 I/O 异常不再终止进程", () => {
  it("入口兜住 unhandledRejection / uncaughtException 且不再强制退出", () => {
    const worker = read("src/worker/index.ts");
    assert.match(worker, /process\.on\("unhandledRejection"/);
    assert.match(worker, /process\.on\("uncaughtException"/);
    assert.match(worker, /EPIPE/);
    assert.doesNotMatch(worker, /process\.exit\(0\)/);
  });

  it("Prisma 连接池按 Supavisor 上限收敛", () => {
    withDatabaseUrl("postgresql://u:p@localhost:5432/db?pgbouncer=true", () => {
      const url = new URL(prismaUrl()!);
      assert.equal(url.searchParams.get("connect_timeout"), "15");
      assert.equal(url.searchParams.get("connection_limit"), "4");
      assert.equal(url.searchParams.get("pool_timeout"), "20");
      assert.equal(url.searchParams.get("pgbouncer"), "true", "已有参数必须保留");
    });
  });

  it("DATABASE_URL 已显式配置的参数不被覆盖", () => {
    withDatabaseUrl("postgresql://u:p@localhost:5432/db?connection_limit=2", () => {
      assert.equal(new URL(prismaUrl()!).searchParams.get("connection_limit"), "2");
    });
  });

  it("缺少 DATABASE_URL 时不抛错", () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.equal(prismaUrl(), undefined);
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
    }
  });
});

describe("历史快照素材兼容与可诊断性", () => {
  it("项目静态占位图转成 data URL，旧任务不再一律失败", async () => {
    const result = await resolveAssetForRender("placeholder-product.svg", "imageUrl");
    assert.match(result, /^data:image\/svg\+xml;base64,/);
  });

  it("被拒素材的错误消息带字段名与值，便于 Worker 日志定位", async () => {
    await assert.rejects(
      () => resolveAssetForRender("https://evil.example/a.png", "logoPath"),
      /不受信任.*logoPath.*https:\/\/evil\.example\/a\.png/
    );
  });

  it("安全边界不变：外部链接 / 本地文件 / 非 uploads 路径仍被拒绝", async () => {
    for (const bad of ["file:///etc/passwd", "/etc/passwd", "videos/u1/j1.mp4"]) {
      await assert.rejects(() => resolveAssetForRender(bad), /不受信任/, bad);
    }
  });
});
