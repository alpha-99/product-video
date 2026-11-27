import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * 模板管理补全（V1.0）的静态守卫：把评审关心的不可让步约束固化成 CI 断言。
 * 纯文本/结构检查，不需要数据库或 Web 服务。
 */
const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("TC-12 / FR-14：管理端路由服务端 gate", () => {
  const adminDir = path.join(root, "src/app/api/admin");
  const routes = walk(adminDir).filter((f) => f.endsWith("route.ts"));

  it("存在所有管理端路由", () => {
    assert.ok(routes.length >= 15, `管理端路由数量不足: ${routes.length}`);
  });

  it("每个 /api/admin/** 路由都经 requireAdmin（adminHandler 封装）", () => {
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(root, file);
      assert.match(
        src,
        /adminHandler|requireAdmin/,
        `${rel} 未调用 requireAdmin / adminHandler`
      );
    }
  });

  it("管理页服务端 gate 存在，普通用户直输 URL 被拦", () => {
    const layout = read("src/app/(app)/admin/layout.tsx");
    assert.match(layout, /checkAdminPage/);
    assert.match(layout, /status === 401|is401/);
    const gate = read("src/lib/admin-page.ts");
    assert.match(gate, /resolveUserId\(headers\(\)\)/);
    assert.match(gate, /user\.role !== "admin"/);
    assert.match(gate, /账号未初始化/);
  });
});

describe("L2 / L4：禁止单步提权与双人复核", () => {
  it("唯一写 role=admin 的 Web 路径是 approveGrant，且带条件更新 count===1", () => {
    const users = read("src/lib/admin-users.ts");
    assert.match(users, /updateMany\(\{[\s\S]{0,120}role: "user"[\s\S]{0,120}role: "admin"/);
    assert.match(users, /granted\.count !== 1/);
    assert.match(users, /req\.requestedBy === actorId/); // 审批人 ≠ 发起人
    assert.match(users, /requester\.role !== "admin"/); // 复核时重查发起人
  });

  it("降权接口只接受 role=user，role=admin 显式拒绝", () => {
    const route = read("src/app/api/admin/users/[id]/role/route.ts");
    assert.match(route, /roleDirectGrantForbidden/);
    const schema = read("src/lib/admin-schemas.ts");
    assert.match(schema, /role: z\.literal\("user"\)/);
  });

  it("登录/注册不接受 role 提权参数（.strict + create 不含 role）", () => {
    const route = read("src/app/api/auth/session/route.ts");
    assert.match(route, /\.strict\(\)/);
    assert.doesNotMatch(route, /data:\s*\{[^}]*role:/);
  });

  it("bootstrap 脚本：≥2 admin 时禁用提权、禁自我提权、写 script 审计", () => {
    const script = read("scripts/set-user-role.ts");
    assert.match(script, /adminCount >= 2/);
    assert.match(script, /禁止自我提权/);
    assert.match(script, /source=script|'script'/);
    assert.match(script, /adminCount <= 1/);
  });
});

describe("FR-05 / B3：启用数守卫排除注册缺失行", () => {
  it("停用守卫计数带 compositionId 在注册表内的条件", () => {
    const svc = read("src/lib/admin-templates.ts");
    assert.match(svc, /enabled: true, compositionId: \{ in: \[\.\.\.REGISTERED\] \}/);
    assert.match(svc, /countRenderableEnabled\(tx\) > 1/);
    assert.match(svc, /templateLastEnabled/);
  });

  it("同步会自动停用注册缺失的启用行并写审计", () => {
    const svc = read("src/lib/admin-templates.ts");
    assert.match(svc, /auto_disabled_registry_missing/);
    assert.match(svc, /registryMissing\(row\.compositionId\) && row\.enabled/);
  });

  it("模板审计与主操作同事务", () => {
    const svc = read("src/lib/admin-templates.ts");
    const txCount = (svc.match(/withTransaction\(/g) ?? []).length;
    assert.ok(txCount >= 6, `withTransaction 使用次数不足: ${txCount}`);
  });
});

describe("§7.3：错误码与 HTTP 状态同步", () => {
  it("全部新增错误码在 ErrorCode / httpStatusFor / 客户端文案三处齐全", () => {
    const api = read("src/shared/api.ts");
    const errs = read("src/lib/errors.ts");
    const client = read("src/lib/client/api.ts");
    for (const code of [
      "TEMPLATE_CONFLICT",
      "TEMPLATE_LAST_ENABLED",
      "TEMPLATE_NOT_REGISTERED",
      "ROLE_SELF_CHANGE",
      "ROLE_DIRECT_GRANT_FORBIDDEN",
      "ROLE_APPROVER_CONFLICT",
      "ROLE_NEEDS_SECOND_ADMIN",
      "ROLE_LAST_ADMIN",
      "ROLE_REQUEST_EXPIRED",
      "ROLE_REQUEST_CONFLICT",
    ]) {
      assert.ok(api.includes(`${code}:`), `ErrorCode 缺少 ${code}`);
      assert.ok(errs.includes(`ErrorCode.${code}`), `httpStatusFor/factory 缺少 ${code}`);
      assert.ok(client.includes(`${code}:`), `客户端文案缺少 ${code}`);
    }
  });

  it("409 与 403 状态映射正确", () => {
    const errs = read("src/lib/errors.ts");
    assert.match(errs, /case ErrorCode\.TEMPLATE_LAST_ENABLED[\s\S]{0,300}return 409/);
    assert.match(errs, /case ErrorCode\.ROLE_SELF_CHANGE[\s\S]{0,120}return 403/);
  });
});

describe("M2 / FR-11 / TC-15：前台兼容与夹具", () => {
  it("三个页面模板缓存 TTL 为 60s，不改 DEFAULT_STALE_MS", () => {
    for (const p of ["templates", "create", "videos"]) {
      const page = read(`src/app/(app)/${p}/page.tsx`);
      assert.match(page, /cacheKey: "templates", ttlMs: 60_000/, `${p} 页面 TTL 未降为 60s`);
    }
    const cache = read("src/lib/client/cache.ts");
    assert.match(cache, /DEFAULT_STALE_MS = 10 \* 60 \* 1000/);
  });

  it("GET /api/templates 只增字段且不加 ETag", () => {
    const route = read("src/app/api/templates/route.ts");
    for (const f of ["displayName", "englishName", "cta", "sortOrder", "thumbnailUrl"]) {
      assert.ok(route.includes(`${f}:`), `响应缺少新字段 ${f}`);
    }
    assert.match(route, /label: displayName/);
    // 只禁止实际设置 ETag 响应头；注释里说明「不加 ETag」是允许的。
    assert.doesNotMatch(route, /headers\.set\(\s*["']ETag|\bETag\s*:/);
  });

  it("4 个测试夹具不再插入 product-launch 临时行（方案 A）", () => {
    for (const f of ["products", "pipeline", "queue"]) {
      const src = read(`tests/${f}.test.ts`);
      assert.doesNotMatch(
        src,
        /INSERT INTO video_templates[\s\S]{0,120}product-launch/,
        `${f}.test.ts 仍插入 product-launch 临时行`
      );
      assert.match(src, /11111111-1111-4111-8111-111111111111/);
    }
  });

  it("新测试文件已加入 package.json test 清单", () => {
    const pkg = read("package.json");
    assert.match(pkg, /tests\/admin-schema\.test\.ts/);
    assert.match(pkg, /tests\/admin-guards\.test\.ts/);
    assert.match(pkg, /"admin:role"/);
  });
});
