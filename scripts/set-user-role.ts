/**
 * 管理员角色 bootstrap / 灾备脚本（方案 V1.0 §8.2.4，U2 降级为受控通道）。
 *
 *   npm run admin:role -- --list
 *   npm run admin:role -- --email a@x.cn --role admin --actor WD-2026-001 --reason "初始化主管理员"
 *   npm run admin:role -- --email b@x.cn --role admin --actor WD-2026-001 --reason "初始化备用管理员"
 *   npm run admin:role -- --email c@x.cn --role user  --actor WD-2026-002 --reason "岗位调整回收"
 *
 * 约束：
 *  - 只在 admin 数 < 2 时允许授予 admin（≥2 必须走页面双人复核）；
 *  - 禁止自我提权（--actor-email 与 --email 相同则拒绝）；
 *  - 变更后 admin 数必须 ≥ 1；重复授予返回「无变更」且不写成功审计；
 *  - 每次真实变更在同一事务内写 user_role_audit_logs（source=script，actor_label=工单号）。
 *
 * 退出码：0 成功/无变更；1 参数或守卫失败。
 */
import process from "node:process";
import { randomUUID } from "node:crypto";
import "../src/lib/env";
import { Pool } from "pg";

interface Options {
  email?: string;
  role?: "admin" | "user";
  actor?: string;
  actorEmail?: string;
  reason?: string;
  list: boolean;
}

function parseArgs(argv: string[]): Options {
  const out: Options = { list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--email") out.email = argv[++i];
    else if (a === "--role") {
      const v = argv[++i];
      if (v !== "admin" && v !== "user") throw new Error(`--role 只能是 admin 或 user，收到: ${v}`);
      out.role = v;
    } else if (a === "--actor") out.actor = argv[++i];
    else if (a === "--actor-email") out.actorEmail = argv[++i];
    else if (a === "--reason") out.reason = argv[++i];
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

function fail(msg: string): never {
  console.error(`[admin:role] ${msg}`);
  process.exit(1);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) fail("缺少 DATABASE_URL");
  const opt = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString });

  try {
    if (opt.list) {
      const { rows } = await pool.query<{ email: string; role: string; created_at: Date }>(
        "SELECT email, role, created_at FROM users WHERE role='admin' ORDER BY created_at ASC"
      );
      console.log(`当前管理员 ${rows.length} 名：`);
      for (const r of rows) console.log(`  ${r.email}  (${r.created_at.toISOString()})`);
      return;
    }

    if (!opt.email || !opt.role) fail("必须同时提供 --email 与 --role；或用 --list");
    if (opt.actorEmail && opt.actorEmail.trim().toLowerCase() === opt.email.trim().toLowerCase()) {
      fail("禁止自我提权：--actor-email 不得与 --email 相同");
    }
    if (!opt.actor || !opt.actor.trim()) fail("必须提供 --actor（工单号），用于审计留痕");
    if (opt.role === "admin" && (!opt.reason || !opt.reason.includes(opt.actor!))) {
      fail("授予 admin 的 --reason 必须包含工单号（灾备留痕）");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: found } = await client.query<{ id: string; role: string }>(
        "SELECT id, role FROM users WHERE email=$1",
        [opt.email]
      );
      if (found.length === 0) {
        await client.query("ROLLBACK");
        fail("目标账号不存在，请先让用户登录创建账号");
      }
      const target = found[0];
      if (target.role === opt.role) {
        await client.query("ROLLBACK");
        console.log(`[admin:role] 无变更：${opt.email} 当前已是 ${opt.role}`);
        return;
      }

      const { rows: countRows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM users WHERE role='admin'"
      );
      const adminCount = countRows[0].n;

      if (opt.role === "admin") {
        // 仅允许 admin 数 < 2 时授予；日常提权走页面复核
        if (adminCount >= 2) {
          await client.query("ROLLBACK");
          fail(`当前已有 ${adminCount} 名管理员，脚本提权已禁用（需走页面双人复核）`);
        }
      } else {
        // 变更后 admin 数 ≥ 1
        if (target.role === "admin" && adminCount <= 1) {
          await client.query("ROLLBACK");
          fail("拒绝撤销最后一名管理员（409 ROLE_LAST_ADMIN 语义）");
        }
      }

      // 条件更新：并发下以数据库当前角色为准，count!==1 视为冲突
      const { rowCount } = await client.query(
        "UPDATE users SET role=$1 WHERE id=$2 AND role=$3",
        [opt.role, target.id, target.role]
      );
      if (rowCount !== 1) {
        await client.query("ROLLBACK");
        fail("目标角色已被并发修改，请重试");
      }

      await client.query(
        `INSERT INTO user_role_audit_logs
          (id, target_user_id, actor_user_id, actor_label, source, from_role, to_role, reason, created_at)
         VALUES ($1,$2,NULL,$3,'script',$4,$5,$6,now())`,
        [randomUUID(), target.id, opt.actor, target.role, opt.role, opt.reason ?? null]
      );
      await client.query("COMMIT");
      console.log(`[admin:role] 成功：${opt.email} ${target.role} → ${opt.role}（工单 ${opt.actor}）`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => fail((err as Error).message));
