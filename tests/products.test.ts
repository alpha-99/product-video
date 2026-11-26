import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import "../src/lib/env";

/**
 * 阶段五商品 CRUD 集成测试（真库 + 真文件）。
 * 无 DATABASE_URL 时整组跳过；所有测试数据用随机 UUID 隔离，结束后级联清理。
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const TEST_ROOT = path.join(os.tmpdir(), `pv-products-test-${Date.now()}`);
const userId = randomUUID();
const otherUserId = randomUUID();
const templateId = randomUUID();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

let products: typeof import("../src/lib/products");
let storage: typeof import("../src/lib/storage");
let listRoute: typeof import("../src/app/api/products/route");
let detailRoute: typeof import("../src/app/api/products/[id]/route");

before(async () => {
  if (!pool) return;
  process.env.STORAGE_ROOT = TEST_ROOT;
  await pool.query(
    "INSERT INTO users (id, email, quota_left) VALUES ($1,$2,10),($3,$4,10)",
    [userId, `p-${userId}@example.invalid`, otherUserId, `p-${otherUserId}@example.invalid`]
  );
  await pool.query(
    `INSERT INTO video_templates (id, name, category, composition_id, duration_sec)
     VALUES ($1,'测试模板','launch','product-launch',15)`,
    [templateId]
  );
  // storage 在模块加载时读取 STORAGE_ROOT，必须先设置环境再导入。
  storage = await import("../src/lib/storage");
  products = await import("../src/lib/products");
  listRoute = await import("../src/app/api/products/route");
  detailRoute = await import("../src/app/api/products/[id]/route");
});

after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [userId, otherUserId]);
  await pool.query("DELETE FROM video_templates WHERE id = $1", [templateId]);
  await pool.end();
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("商品 CRUD 与归属校验（阶段五）", { skip: !hasDb }, () => {
  let mainProductId: string;
  let firstImagePath: string;
  let secondImagePath: string;

  async function saveDraft(name: string): Promise<string> {
    const relative = storage.uploadRelativePath(userId, "draft", name);
    await storage.fileStorage.save(PNG, relative);
    return relative;
  }

  const auth = (id: string) => ({ "x-dev-user-id": id, "content-type": "application/json" });
  const baseUrl = "http://localhost/api/products";

  it("新增商品：draft 图片迁移到商品目录，数据库字段落库正确", async () => {
    const draft = await saveDraft("first.png");
    const created = await products.createProduct(userId, {
      name: "水润面霜",
      imagePath: draft,
      description: "日常保湿",
      price: "29.99",
      sellingPoints: ["轻盈", "保湿"],
      brandName: "AURA",
      brandColor: "#abcdef",
    });

    mainProductId = created.id!;
    firstImagePath = storage.uploadRelativePath(userId, mainProductId, "first.png");
    assert.match(mainProductId, /^[0-9a-f-]{36}$/i);
    assert.equal(created.imagePath, firstImagePath);
    assert.equal(await storage.fileStorage.exists(firstImagePath), true);
    assert.equal(await storage.fileStorage.exists(draft), false);

    const { rows } = await pool!.query(
      "SELECT name, price::text AS price, selling_points, brand_color FROM products WHERE id=$1",
      [mainProductId]
    );
    assert.equal(rows[0].name, "水润面霜");
    assert.equal(rows[0].price, "29.99");
    assert.deepEqual(rows[0].selling_points, ["轻盈", "保湿"]);
    assert.equal(rows[0].brand_color, "#abcdef");
  });

  it("列表与详情强制归属当前用户", async () => {
    const mine = await products.listProducts(userId);
    assert.ok(mine.some((item) => item.id === mainProductId));
    assert.equal((await products.listProducts(otherUserId)).length, 0);
    assert.equal((await products.getProduct(userId, mainProductId)).name, "水润面霜");
    await assert.rejects(() => products.getProduct(otherUserId, mainProductId), /不属于当前用户/);
  });

  it("编辑商品：换图后旧文件被清理，局部字段更新，updated_at 前进", async () => {
    secondImagePath = await saveDraft("second.png");
    const beforeRow = await pool!.query(
      "SELECT updated_at FROM products WHERE id=$1",
      [mainProductId]
    );
    const previousUpdatedAt = beforeRow.rows[0].updated_at as Date;
    const updated = await products.updateProduct(userId, mainProductId, {
      name: "新名字",
      price: "39.00",
      imagePath: secondImagePath,
    });

    const expectedSecond = storage.uploadRelativePath(userId, mainProductId, "second.png");
    assert.equal(updated.name, "新名字");
    // Prisma Decimal 的 toString 会去掉无意义尾零，按数值比较。
    assert.equal(Number(updated.price), 39);
    assert.equal(updated.imagePath, expectedSecond);
    assert.equal(await storage.fileStorage.exists(expectedSecond), true);
    assert.equal(await storage.fileStorage.exists(firstImagePath), false);
    assert.equal(updated.description, "日常保湿");

    const afterRow = await pool!.query(
      "SELECT created_at, updated_at FROM products WHERE id=$1",
      [mainProductId]
    );
    // 只校验触发器确实改写了 updated_at；远端池化连接下 now() 的先后可能与本地时钟不一致。
    assert.notEqual(
      (afterRow.rows[0].updated_at as Date).getTime(),
      previousUpdatedAt.getTime()
    );
  });

  it("拒绝引用他人上传件；API 校验失败返回 400 + fields", async () => {
    const foreign = storage.uploadRelativePath(otherUserId, "draft", "foreign.png");
    await assert.rejects(
      () => products.updateProduct(userId, mainProductId, { imagePath: foreign }),
      /不属于当前用户/
    );

    const bad = await listRoute.POST(
      new NextRequest(baseUrl, {
        method: "POST",
        headers: auth(userId),
        body: JSON.stringify({ name: "x".repeat(201), imagePath: "legacy/a.png" }),
      })
    );
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: { fields?: Record<string, string> } };
    assert.ok(body.error.fields?.name);
  });

  it("API 冒烟：POST 201 / GET 200 / 跨用户 404 / 非法 UUID 400 / 无鉴权 401", async () => {
    const unauth = await listRoute.POST(
      new NextRequest(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "无鉴权", imagePath: "legacy/a.png" }),
      })
    );
    assert.equal(unauth.status, 401);

    const created = await listRoute.POST(
      new NextRequest(baseUrl, {
        method: "POST",
        headers: auth(userId),
        body: JSON.stringify({ name: "API商品", imagePath: "legacy/a.png", sellingPoints: [] }),
      })
    );
    assert.equal(created.status, 201);
    const { data } = (await created.json()) as { data: { id: string } };

    const detail = await detailRoute.GET(
      new NextRequest(`${baseUrl}/${data.id}`, { headers: auth(userId) }),
      { params: { id: data.id } }
    );
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { data: { name: string } }).data.name, "API商品");

    const cross = await detailRoute.GET(
      new NextRequest(`${baseUrl}/${data.id}`, { headers: auth(otherUserId) }),
      { params: { id: data.id } }
    );
    assert.equal(cross.status, 404);

    const malformed = await detailRoute.GET(
      new NextRequest(`${baseUrl}/not-a-uuid`, { headers: auth(userId) }),
      { params: { id: "not-a-uuid" } }
    );
    assert.equal(malformed.status, 400);

    const deleted = await detailRoute.DELETE(
      new NextRequest(`${baseUrl}/${data.id}`, { method: "DELETE", headers: auth(userId) }),
      { params: { id: data.id } }
    );
    assert.equal(deleted.status, 200);
    const { rows } = await pool!.query("SELECT id FROM products WHERE id=$1", [data.id]);
    assert.equal(rows.length, 0);
  });

  it("删除商品：清理上传件；跨用户 404；已关联视频任务时拒绝", async () => {
    const targetDraft = await saveDraft("third.png");
    const target = await products.createProduct(userId, {
      name: "待删除",
      imagePath: targetDraft,
      sellingPoints: [],
    });
    const targetId = target.id!;
    const targetImage = target.imagePath;
    assert.equal(await storage.fileStorage.exists(targetImage), true);

    await assert.rejects(() => products.deleteProduct(otherUserId, targetId), /不属于当前用户/);
    await pool!.query(
      `INSERT INTO video_jobs (user_id, product_id, template_id, input_json, idempotency_key)
       VALUES ($1,$2,$3,'{}'::jsonb,$4)`,
      [userId, targetId, templateId, `job-${randomUUID()}`]
    );
    await assert.rejects(() => products.deleteProduct(userId, targetId), /无法删除/);

    await pool!.query("DELETE FROM video_jobs WHERE product_id=$1", [targetId]);
    await products.deleteProduct(userId, targetId);
    assert.equal(await storage.fileStorage.exists(targetImage), false);
    await assert.rejects(() => products.getProduct(userId, targetId), /不存在/);
  });
});
