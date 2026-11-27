import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * 模板管理补全（V1.0）的数据库层守卫：
 *  - 005 迁移在真实 Postgres 引擎（PGlite）上可重复执行；
 *  - 运营元数据 / 角色 / 三张新表齐全；
 *  - 关键约束（唯一 composition_id、tone 枚举、角色二值、双人复核 CHECK）生效；
 *  - 种子回填逐字一致（TC-05 基础）。
 */
const root = path.resolve(__dirname, "..");
const readSql = (f: string) => readFile(path.join(root, "db", "migrations", f), "utf8");

async function freshDb() {
  const db = new PGlite();
  await db.exec(await readSql("001_init.sql"));
  await db.exec(await readSql("003_seed_templates.sql"));
  await db.exec(await readSql("004_ops.sql"));
  return db;
}

describe("005_template_admin.sql 迁移与约束", () => {
  it("连续执行两遍成功（幂等），三张新表与字段齐全", async () => {
    const db = await freshDb();
    try {
      await db.exec(await readSql("005_template_admin.sql"));
      await db.exec(await readSql("005_template_admin.sql")); // 第二遍

      const tables = await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
      );
      const names = tables.rows.map((r) => r.tablename);
      for (const t of [
        "template_audit_logs",
        "user_role_audit_logs",
        "user_role_change_requests",
      ]) {
        assert.ok(names.includes(t), `缺少表 ${t}`);
      }

      const vt = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='video_templates'"
      );
      const cols = vt.rows.map((r) => r.column_name);
      for (const c of [
        "display_name",
        "english_name",
        "description",
        "cta",
        "tone",
        "sort_order",
        "updated_at",
        "updated_by",
        "version",
      ]) {
        assert.ok(cols.includes(c), `video_templates 缺少列 ${c}`);
      }
      const users = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='users'"
      );
      assert.ok(users.rows.some((r) => r.column_name === "role"), "users 缺少 role 列");
    } finally {
      await db.close();
    }
  });

  it("种子模板回填展示元数据与 sort_order，逐字一致", async () => {
    const db = await freshDb();
    try {
      await db.exec(await readSql("005_template_admin.sql"));
      const { rows } = await db.query<{
        composition_id: string;
        display_name: string;
        english_name: string;
        cta: string;
        sort_order: number;
      }>("SELECT composition_id, display_name, english_name, cta, sort_order FROM video_templates ORDER BY sort_order");
      assert.equal(rows.length, 5);
      assert.deepEqual(
        rows.map((r) => r.composition_id),
        ["product-launch", "product-highlight", "product-sale", "product-showcase", "product-story"]
      );
      assert.deepEqual(
        rows.map((r) => r.sort_order),
        [10, 20, 30, 40, 50]
      );
      const launch = rows[0];
      assert.equal(launch.english_name, "Product Launch");
      assert.equal(launch.cta, "Discover More");
    } finally {
      await db.close();
    }
  });

  it("唯一 composition_id：重复行归并后加约束成功，重复执行不报错", async () => {
    const db = await freshDb();
    try {
      // 制造一条重复（模拟历史脏数据）：同 composition_id、更晚 created_at
      await db.exec(
        `INSERT INTO video_templates (id, name, category, composition_id, created_at)
         VALUES ('99999999-9999-4999-8999-999999999999','重复','launch','product-launch', now() + interval '1 day')`
      );
      await db.exec(await readSql("005_template_admin.sql"));
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM video_templates WHERE composition_id='product-launch'"
      );
      assert.equal(rows[0].n, 1, "重复行应被归并");
      await assert.rejects(
        db.exec(
          `INSERT INTO video_templates (name, category, composition_id)
           VALUES ('again','launch','product-launch')`
        ),
        /unique|UNIQUE/i
      );
    } finally {
      await db.close();
    }
  });

  it("枚举与守卫约束生效：tone / role / 复核单不可自批", async () => {
    const db = await freshDb();
    try {
      await db.exec(await readSql("005_template_admin.sql"));
      const uidA = "00000000-0000-4000-8000-0000000000a1";
      const uidB = "00000000-0000-4000-8000-0000000000b2";
      await db.exec(
        `INSERT INTO users (id,email) VALUES ('${uidA}','a@e.invalid'),('${uidB}','b@e.invalid')`
      );
      // 非法 tone
      await assert.rejects(
        db.exec(`UPDATE video_templates SET tone='bogus' WHERE composition_id='product-launch'`),
        /tone|check/i
      );
      // 非法 role
      await assert.rejects(
        db.exec(`UPDATE users SET role='superadmin' WHERE id='${uidA}'`),
        /role|check/i
      );
      // 合法 role
      await db.exec(`UPDATE users SET role='admin' WHERE id='${uidA}'`);
      // 自批：requested_by = reviewed_by 应被 CHECK 拒绝
      await assert.rejects(
        db.exec(
          `INSERT INTO user_role_change_requests
             (target_user_id,to_role,requested_by,reason,expires_at,reviewed_by,status)
           VALUES ('${uidB}','admin','${uidA}','r',now()+interval '1 hour','${uidA}','approved')`
        ),
        /reviewer|check/i
      );
    } finally {
      await db.close();
    }
  });
});
