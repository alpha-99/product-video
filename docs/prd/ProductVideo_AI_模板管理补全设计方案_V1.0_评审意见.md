# PRD 评审意见：模板管理补全设计方案 V1.0（r2）

| 项 | 内容 |
|----|------|
| 被评审文档 | `docs/prd/ProductVideo_AI_模板管理补全设计方案_V1.0.md`（r2，2026-11-27） |
| 评审日期 | 2026-11-27 |
| 评审依据 | 文档正文 + 代码基线核对（`src/app/api/templates/route.ts`、`src/lib/jobs.ts`、`src/lib/job-state.ts`、`src/lib/auth.ts`、`src/lib/session.ts`、`src/lib/upload.ts`、`src/lib/api-response.ts`、`src/lib/errors.ts`、`src/shared/api.ts`、`src/shared/template.schema.ts`、`src/lib/client/*`、`prisma/schema.prisma`、`db/migrations/001~003`、`tests/*`、`package.json`） |
| 评审结论 | **有条件通过**：方向正确，存在 4 个阻塞项需修订为 r3 后再排期 |

---

## 0. 结论速览

认同的主线：

- 两层单一真源（渲染契约留代码、运营元数据进 DB）
- 模板只停用不删除（FK + 快照追溯）
- 权限以服务端查库判定，不信任任何客户端角色声明
- 管理员账号生命周期纳入本期，并用双人复核堵自助提权

需要修订的问题：

| 级别 | 数量 | 说明 |
|------|------|------|
| 阻塞（B） | 4 | 与代码基线不符，按文档实现会出错或测试必红 |
| 设计缺陷（D） | 5 | 逻辑矛盾或留有安全/体验漏洞 |
| 基线小错（M） | 5 | 描述与代码不一致，实现时需注意 |
| 范围建议（S） | 3 | 建议降级或后置，控制 r2 已增加的工期 |

---

## 1. 阻塞项（必须修订）

### B1. 测试夹具冲突的描述不准确，且修复方案有隐含障碍

**文档说法**（G-08、RK-01、§6.2 回滚段）：并行测试夹具会插重复 `composition_id` 行，改为随机 `composition_id` 即可。

**代码实际**：

- `tests/products.test.ts:36`、`tests/pipeline.test.ts:36`、`tests/queue.test.ts:33`、`tests/migration.test.ts:61` 都插入固定 `composition_id = 'product-launch'`
- `db/migrations/003_seed_templates.sql` 已有同值行
- 加唯一约束后，这 4 个文件的 `before` 钩子直接失败

**隐含障碍**：`src/lib/jobs.ts:62` 的 `createVideoJob` 要求 `getTemplate(compositionId)` 命中注册表，注册表是封闭的 4 个 id。需要提交任务的测试**不能用随机 composition_id**。

**建议**：

1. 修正 G-08 / RK-01 的描述为“夹具与种子行冲突”。
2. 夹具改造方案二选一：
   - 夹具直接复用种子行 id（`11111111-1111-4111-8111-111111111111`），不再自插模板行；`after` 钩子不再 `DELETE FROM video_templates`
   - 或在 `before` 中先删种子行再插同 `composition_id` 的临时行，`after` 恢复种子
3. 无论哪种，`after` 钩子的 `DELETE FROM video_templates WHERE id = $1` 需要同步检查，避免误删种子行。

### B2. “停用后 `retry` 被拒绝”与代码不符

**文档说法**（FR-12、TC-04、§9 停用影响面表）：`retry` / `regenerate` 复用 `createVideoJob`，模板停用后一律被拒。

**代码实际**：

- `src/lib/jobs.ts:179` `regenerateFromCompletedJob` → `createVideoJob` ✓ 会被 `enabled` 拒绝
- `src/lib/job-state.ts:97` `retryJob` 直接 `updateMany` 重置状态 + `consumeQuota`，**不回查模板**，停用后仍可重试

**建议**：二选一，并在 TC-04 与 §9 表中同步。

- **方案 ①（推荐）**：FR-12 改为“`retry` 不受模板停用影响”。理由：`retry` 是对已扣费失败任务的补偿，`input_json` 快照自包含 compositionId，运营下架不应让用户已付费的重试入口失效。
- 方案 ②：在 `retryJob` 事务内加 `enabled` 校验，拒绝时提示“模板已停用”。需额外定义：该任务是否返还额度、`attempt` 是否计数。

### B3. “至少保留一套”守卫未覆盖 `registryMissing`

**文档说法**（FR-05、§6.3）：系统保证“注册表命中且 enabled=true”的模板数 ≥ 1。

**漏洞**：模板启用后代码发版移除了某个 Composition，DB 行仍是 `enabled=true`。此时：

- 按 DB 计数“启用数”仍 ≥ 1
- 管理员可以停用最后一个**真正可渲染**的模板
- 前台 `GET /api/templates` 过滤后返回空列表，全站无法创作

**建议**：

1. 停用守卫的计数条件必须是 `enabled = true AND composition_id ∈ TEMPLATES`，不能只数 DB 行。
2. 同步动作检测到 `registryMissing` 时，自动将该行 `enabled = false` 并写审计（action: `auto_disabled_registry_missing`），否则这些行会永久占用“启用数”名额。
3. §4.3 一致性守卫补一条：“DB 有、注册表无且 enabled=true → 同步时自动停用”。

### B4. 生产 Supabase JWT 路径下 `users` 行来源未定义

**文档说法**（A6、RK-11、§8.2.6）：生产接 Supabase Auth 后用户主体会变，本期按 `PV_AUTH_MODE=local` 做。

**代码实际**：

- `db/migrations/001_init.sql:9` 注释“主键直接复用 auth.users.id”，`users` 表没有从 Supabase Auth 自动建行的机制
- `src/lib/auth.ts:67` JWT 路径只验签就返回 `sub`
- `src/app/api/me/route.ts:17` 查不到 `users` 行时返回 401

**影响**：若生产走 Supabase JWT，`requireAdmin` 对所有请求都会 401，管理页进不去，`admin:role` 脚本也无处写 `role`。文档没有把这个前提写成显式依赖。

**建议**：

1. 在 §11.1 增加**阻塞依赖**：“本期管理端以 `PV_AUTH_MODE=local` 为前提；若生产走 Supabase JWT，须先定义 `auth.users` → `users` 行的同步方式（Webhook 或首次登录 upsert），并保证 `role` 列落在本库”。
2. `requireAdmin` 对“JWT 合法但 `users` 行不存在”的情况明确返回 401 + 文案“账号未初始化”，与 `/api/me` 口径一致。
3. TC-02 补一条：Given 合法 JWT 但 `users` 无行，When 调用管理接口，Then 401。

---

## 2. 设计缺陷（强烈建议修订）

### D1. 批准提权事务缺少对 target 行的并发保护

**位置**：§8.1 伪代码 `assert(target.role === "user")` → `tx.user.update(...)`。

**问题**：`assert` 与 `update` 之间无锁。虽然部分唯一索引保证同一时刻只有 1 条 pending，但 A 的申请被驳回后 B 可立即再申请；两条申请单在极短时间内被不同审批人并发批准，可能出现双写或 `reviewed_by` 与实际生效路径不一致。

**建议**：批准事务内用 `updateMany({ where: { id: target.id, role: "user" }, data: { role: "admin" } })` 并断言 `count === 1`，或先 `SELECT ... FOR UPDATE` 锁 target 行。TC-20 补一条并发批准用例。

### D2. 复核单 24h 过期依赖惰性置位，列表会显示可批准的过期单

**位置**：§9.2 “定时任务或批准时惰性置位”。

**问题**：项目目前没有定时任务基础设施。若列表接口不过滤 `expires_at`，审批人看到的是可批准状态，点击后才 409，体验差且容易误判。

**建议**：`GET /api/admin/users/role-requests` 查询时按 `expires_at > now()` 过滤 pending；对已过期但仍为 pending 的行在响应中标记为 `expired`（或在读取时顺手 `UPDATE ... SET status='expired'`）。删除对定时任务的依赖。

### D3. 成员列表 email 模糊搜索是枚举攻击面

**位置**：FR-15、§7.2 `GET /api/admin/users` 的 `keyword`（email）。

**问题**：admin 可逐字母试探，枚举出全站注册邮箱。用户量上来后这不再是“选择提权目标”，而是用户名单导出，与 §8.3 PII 最小化口径冲突。

**建议**：在 §13 增加待确认项 Q6，评审时拍板：

- 方案 A：只允许**精确 email** 匹配（最保守）
- 方案 B：前缀匹配，且要求 ≥ 3 个字符
- 方案 C：默认只列出 admin + 最近 30 天有登录/提交记录的用户

无论哪种，补充限流（如 10 次/分）并写入 `admin_forbidden` 同类埋点。

### D4. 模板审计“写失败不阻断”与“同事务”自相矛盾

**位置**：FR-09 “审计写失败应记结构化告警但不得阻断主操作”；§7.3 “写操作统一在事务内完成更新 + 审计 + version+1”。

**问题**：同事务意味着审计写失败必然回滚主操作，两条描述不能同时成立。§8.2.3 还特意把“模板审计不阻断 / 角色审计阻断”作为差异点强调，但实现上若按 §7.3 做，两者行为其实一致。

**建议**：统一为**同事务、失败整笔回滚**。模板只有 4 行，不存在高并发写审计的性能顾虑；少一个分支，少一个不一致点。FR-09 改为“审计与主操作同一事务，写失败整笔回滚并返回 500”，§8.2.3 的差异段落删除，§10 依赖行同步修改。

### D5. `ETag` 没有消费者

**位置**：§7.1 `GET /api/templates` “响应带 `ETag`”。

**问题**：`src/app/(app)/templates/page.tsx:22` 使用 `useAsync` + `cacheKey: "templates"` 的模块级缓存，`src/lib/client/api.ts` 的 `fetch` 不处理 `If-None-Match`。ETag 加了没人用。

**建议**：删除 ETag 要求；若保留，需明确消费方（如 `api.get` 增加 304 处理）。

---

## 3. 与代码基线不符的小错误

| # | 位置 | 文档说法 | 代码实际 | 建议 |
|---|------|----------|----------|------|
| M1 | §4.2、RK-04 | 删除 `TEMPLATE_DISPLAY` 映射 | `tests/ui-audit.test.ts:105-107` 断言 `displayFor(template.compositionId)` / `display.englishName` / `display.cta` 必须出现在 templates 页 | §6.2 步骤 6 补“同步修改 `ui-audit.test.ts` 断言” |
| M2 | §7.1 | 缓存 TTL 由 5min 降至 60s | 落点是 `src/app/(app)/templates/page.tsx:22` 的 `ttlMs: 5 * 60_000` | 明确写出落点，避免实现者误改 `DEFAULT_STALE_MS`（影响所有页面） |
| M3 | §7.3 | `TEMPLATE_IN_USE` 409 “任何删除类请求” | 不存在删除接口，无触发路径 | 删除该错误码 |
| M4 | §1.1 | `/api/me` “只 select 4 个字段” | 实际已返回 `id/email/quotaLeft/createdAt`，与 FR-15 成员列表字段一致 | 无需改动，仅确认 |
| M5 | §5 TC-02 | 伪造 `X-Dev-User-Id` → 403 | `auth.ts:71` 该头仅在 `NODE_ENV !== "production"` 生效；测试环境下伪造头会被当成真实身份 | TC-02 应改为“以普通用户身份 + 伪造 JWT role claim”，并注明 `X-Dev-User-Id` 仅在非生产可用，生产 fail-closed |

---

## 4. 范围建议（控制 r2 新增工期）

| # | 条目 | 现状 | 建议 |
|---|------|------|------|
| S1 | FR-02 关联任务数 | Must | 降为 Should。属查看类功能，需每行 `COUNT(*)` on `video_jobs` |
| S2 | §6.4 埋点 13 个事件 | Must（隐含） | 项目目前无埋点基础设施（`src/lib` 无 analytics 模块），这是一块隐性从 0 到 1。本期只做审计表，埋点另立需求 |
| S3 | FR-17 “批准后通知全体 admin” | Must | 项目无通知基础设施。改为“待复核 Tab + 顶部红点”，不做推送 |

---

## 5. 评审时需直接拍板的问题

| # | 问题 | 建议选项 |
|---|------|----------|
| Q-A | 本期生产是否以 `PV_AUTH_MODE=local` 为前提？（决定 B4 与账号页可用性） | 是：写入 §11.1 阻塞依赖；否：先定义 Supabase 用户同步 |
| Q-B | `retry` 是否受模板停用影响？ | 不受（方案 ①） |
| Q-C | 成员列表 email 搜索方式？ | 精确匹配或前缀 ≥ 3 字符（D3） |
| Q-D | 模板审计是否与角色审计统一为同事务？ | 是（D4） |

---

## 6. 修订清单（供 r3 对照）

- [ ] B1：修正 G-08 / RK-01 描述；给出夹具改造方案
- [ ] B2：FR-12、TC-04、§9 停用影响面表按拍板结果修改
- [ ] B3：FR-05 守卫计数条件；§4.3 补自动停用；同步动作新增审计 action
- [ ] B4：§11.1 新增阻塞依赖；`requireAdmin` 对无 `users` 行的行为；TC-02 补用例
- [ ] D1：§8.1 伪代码改为条件更新 / 行锁；TC-20 补并发批准
- [ ] D2：§9.2 删除定时任务依赖；列表接口按 `expires_at` 过滤
- [ ] D3：§13 新增 Q6；FR-15 补限流
- [ ] D4：FR-09、§7.3、§8.2.3、§10 统一为同事务
- [ ] D5：删除 ETag 或明确消费方
- [ ] M1~M5：逐条修正
- [ ] S1~S3：按评审结论调整优先级
- [ ] 附录 A RTM 补 B3 / D1 / D2 对应的 TC
