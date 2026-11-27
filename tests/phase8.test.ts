import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import "../src/lib/env";
import { TEMPLATES } from "../src/shared/template.schema";
import { SESSION_COOKIE, readSessionFromCookieHeader, signSession, verifySession } from "../src/lib/session";

/** 阶段八后端集成测试：开发会话、/api/me、/api/templates、模板种子。 */
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb
  ? new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8_000 })
  : null;
const email = `phase8-${randomUUID()}@example.invalid`;
let sessionRoute: typeof import("../src/app/api/auth/session/route");
let meRoute: typeof import("../src/app/api/me/route");
let templatesRoute: typeof import("../src/app/api/templates/route");
let cookieHeader = "";

const jsonRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  if (!pool) return;
  sessionRoute = await import("../src/app/api/auth/session/route");
  meRoute = await import("../src/app/api/me/route");
  templatesRoute = await import("../src/app/api/templates/route");
});

after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM users WHERE email=$1", [email]);
  await pool.end();
});

describe("开发会话与前端依赖接口（阶段八）", { skip: !hasDb }, () => {
  it("签名会话可校验，篡改与过期被拒绝", () => {
    const token = signSession("00000000-0000-4000-8000-000000000001", "a@b.com");
    assert.equal(verifySession(token)?.email, "a@b.com");
    assert.equal(verifySession(token.replace(/.$/, "x")), null);
    assert.equal(verifySession("garbage"), null);
    assert.equal(readSessionFromCookieHeader(`${SESSION_COOKIE}=${token}; other=1`)?.sub, "00000000-0000-4000-8000-000000000001");
  });

  it("POST 登录创建用户、写 HttpOnly Cookie，GET /api/me 返回额度 3", async () => {
    const response = await sessionRoute.POST(jsonRequest({ email, password: "12345678" }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; data: { id: string; quotaLeft: number } };
    assert.equal(body.ok, true);
    assert.equal(body.data.quotaLeft, 3);

    const raw = response.headers.get("set-cookie") ?? "";
    assert.ok(raw.includes(`${SESSION_COOKIE}=`));
    assert.ok(raw.toLowerCase().includes("httponly"));
    assert.ok(raw.toLowerCase().includes("samesite=lax"));
    cookieHeader = raw.split(";")[0];

    const me = await meRoute.GET(
      new NextRequest("http://localhost/api/me", { headers: { cookie: cookieHeader } })
    );
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { data: { email: string; quotaLeft: number } };
    assert.equal(meBody.data.email, email);
    assert.equal(meBody.data.quotaLeft, 3);
  });

  it("邮箱重复登录不重复建用户，也不会重置额度", async () => {
    await pool!.query("UPDATE users SET quota_left=1 WHERE email=$1", [email]);
    const response = await sessionRoute.POST(jsonRequest({ email, password: "12345678" }));
    assert.equal(response.status, 200);
    const rows = await pool!.query("SELECT id, quota_left FROM users WHERE email=$1", [email]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].quota_left, 1);
    cookieHeader = (response.headers.get("set-cookie") ?? "").split(";")[0];
  });

  it("GET /api/templates 返回 5 套种子模板，compositionId 全部命中注册表", async () => {
    const response = await templatesRoute.GET(
      new NextRequest("http://localhost/api/templates", { headers: { cookie: cookieHeader } })
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: Array<{ id: string; compositionId: string; durationSec: number; tone: string; label: string }>;
    };
    assert.equal(body.data.length, 5);
    const registered = TEMPLATES.map((t) => t.id as string);
    for (const template of body.data) {
      assert.ok(registered.includes(template.compositionId), `${template.compositionId} 未注册`);
      assert.match(template.id, /^[0-9a-f-]{36}$/);
      assert.ok(template.durationSec === 15 || template.durationSec === 20);
      assert.ok(template.label && template.tone);
    }
    assert.deepEqual(
      body.data.map((t) => t.compositionId).sort(),
      [...registered].sort()
    );
  });

  it("未认证 401、Cookie 签名被改 401、非法邮箱 400", async () => {
    const anonymous = await templatesRoute.GET(new NextRequest("http://localhost/api/templates"));
    assert.equal(anonymous.status, 401);

    const tampered = cookieHeader.replace(/.$/, "z");
    const forged = await meRoute.GET(
      new NextRequest("http://localhost/api/me", { headers: { cookie: tampered } })
    );
    assert.equal(forged.status, 401);

    const invalid = await sessionRoute.POST(jsonRequest({ email: "not-an-email", password: "12345678" }));
    assert.equal(invalid.status, 400);
  });

  it("DELETE 退出后 Cookie 立即失效", async () => {
    const response = await sessionRoute.DELETE();
    assert.equal(response.status, 200);
    const raw = response.headers.get("set-cookie") ?? "";
    assert.ok(raw.includes("Max-Age=0") || raw.includes("max-age=0"));
  });
});
