# ProductVideo AI · 模板管理补全设计方案 V1.0

| 项 | 内容 |
|----|------|
| 版本 | V1.0（r3 修订，2026-11-27） |
| 日期 | 2026-11-27 |
| 状态 | **有条件通过**（评审结论）；r3 已按评审意见修订，待 §13.1 的 4 项拍板签字后再排期 |
| 依据 | `output/productvideo-docs/stage1/organized_draft_prd.md` 第 3/4/5.4 节、`technical_design_detailed.md` 第 5/7 章；**`docs/prd/ProductVideo_AI_模板管理补全设计方案_V1.0_评审意见.md`**；现有代码基线（`src/app/api/templates/route.ts`、`src/shared/template.schema.ts`、`src/lib/jobs.ts`、`src/lib/job-state.ts`、`src/lib/auth.ts`、`src/lib/session.ts`、`src/app/api/me/route.ts`、`src/app/api/auth/session/route.ts`、`src/shared/api.ts`、`src/lib/errors.ts`、`src/components/AppShell.tsx`、`src/lib/client/{api,cache,hooks,template-display}.ts`、`src/app/(app)/{templates,create,videos}/page.tsx`、`src/lib/upload.ts`、`package.json`、`db/migrations/001~004`、`tests/*`） |
| 变更记录 | r1（2026-11-27）：补充 §8.1 鉴权实现落点、§8.2 用户与管理员账号管理。<br>r2（2026-11-27）：Q2 拍板「管理员账号管理页一起做，自助提权防护加进去」；§8.2 重写为账号子页 + 四层防护 + 提权双人复核 + 脚本降级为 bootstrap/灾备。<br>**r3（2026-11-27）：按评审意见「有条件通过」修订 4 个阻塞项（B1~B4）、5 个设计缺陷（D1~D5）、5 处基线校正（M1~M5）、3 条范围收缩（S1~S3）；逐条决策见附录 C，变更评估见 §2.5。评审原文未改动。** 文件名沿用初版，内容版本以本表为准 |
| 合规声明 | 本方案为产品设计参考，具体实施请结合公司合规与法务要求确认 |

---

## 0. 结论速览

**沿用已确认口径**：渲染契约留在代码层手动维护、模板只停用不删除、权限以服务端查库判定、管理员账号页与自助提权防护纳入本期、提权双人复核。**r3 新增口径**：`retry` 不受模板停用影响、启用数守卫必须排除注册缺失行、模板与角色审计统一同事务、本期不建埋点与通知基础设施。

**推荐方案 B：把「渲染契约」与「运营元数据」拆成两层单一真源，补齐管理员端的列表/编辑/启停/分类排序/缩略图/同步/审计闭环；管理员账号生命周期收进管理端，用「四层防护 + 提权双人复核」堵住自助提权。**

四条不可让步的硬约束：

1. **禁止在管理端新增/手填 `compositionId`，禁止上传或粘贴 Remotion 代码**（沿用技术方案「用户上传自定义 Remotion 代码 = 安全红线」）。新模板必须先代码发版注册，再由「同步」动作生成 DB 行。
2. **模板不可删除，只能停用**：`video_jobs.template_id` 外键 + `input_json` 渲染快照需要可追溯。管理端不提供 DELETE 接口。
3. **停用判定以服务端为准，且「启用数」只数真正可渲染的行**：`createVideoJob` 已强制 `enabled: true` + 注册表命中；启用数 = `enabled=true ∧ composition_id ∈ TEMPLATES`，注册缺失行不计入且同步时自动停用。
4. **权限判定以服务端查库为准，且任何单个管理员都不能独自完成提权**：管理员身份只认 `users.role`，不认请求里带的任何角色声明；首个/灾备管理员由运维脚本 bootstrap，日常提权必须经**另一名管理员复核**；禁止改自己角色、禁止单步写 `role=admin` 的接口。

> **r3 阻塞项修订摘要**：B1 夹具冲突改为「与种子行同值」并给出可落地改造方案；B2 `retry` 与 `regenerate` 口径拆分；B3 启用数计数条件 + 注册缺失自动停用；B4 补生产 Auth 前提依赖与「账号未初始化」401。详见附录 C 决策表。

---

## 1. 现状盘点与差距

### 1.1 已实现（基线，勿重复建设）

| 能力 | 位置 | 说明 |
|------|------|------|
| 模板表与 4 条种子 | `001_init.sql` / `003_seed_templates.sql` | 字段：`name/category/composition_id/duration_sec/thumbnail_path/config/enabled/created_at`；固定 UUID（如 `product-launch` = `11111111-1111-4111-8111-111111111111`），按 `composition_id` 幂等判重 |
| 渲染契约注册表 | `src/shared/template.schema.ts` | `TEMPLATES` 定义 4 个 Composition 的 id、规格（1080×1920/30fps/15 或 20s）、`defaultProps`；`getTemplate()` 对未知 id **fail-closed 抛错** |
| 前台只读列表 | `GET /api/templates` | 仅 `enabled=true`、过滤未注册 `compositionId`、按 `compositionId` 去重，`orderBy category` |
| 前台选择页 | `src/app/(app)/templates/page.tsx` | radiogroup 卡片、方向键/roving tabindex、选中后跳 `/create?templateId=`；`useAsync` 的 `ttlMs: 5 * 60_000` |
| 提交链路守卫 | `src/lib/jobs.ts` | `findFirst({ id, enabled:true })` → `getTemplate(compositionId)` → 快照 `input_json`（含 compositionId + props） |
| 任务状态机（r3 补） | `src/lib/job-state.ts` | `retryJob` 仅重置 `failed/cancelled` 任务状态并重新扣额度，**不回查模板**；`regenerateFromCompletedJob` 走 `createVideoJob`（会校验 enabled） |
| 图片校验器 | `src/lib/upload.ts` | 扩展名白名单（拒 SVG）+ MIME 一致 + magic sniff + ≤10MB + UUID 重命名 |
| 前端 SWR 缓存 | `src/lib/client/{cache,hooks}.ts` | `templates` 缓存；**`ttlMs` 落点在 `templates/create/videos` 3 个页面**，`DEFAULT_STALE_MS` 是全站默认值，勿改 |
| 统一错误包络 | `src/lib/errors.ts` / `src/lib/api-response.ts` | `errors.forbidden()` 已存在并映射 403；但 `src/shared/api.ts` 的 `ErrorCode` 是**封闭常量**，目前无任何 409 码（见 §7.3） |
| 鉴权入口 | `src/lib/auth.ts` / `src/lib/session.ts` | `resolveUserId()` 只返回用户 UUID；Cookie `SessionPayload` 仅 `sub/email/exp`，不含角色；`X-Dev-User-Id` 仅在 `NODE_ENV !== "production"` 生效 |
| 登录/注册 | `src/app/api/auth/session/route.ts` | `LoginSchema` 仅 `email/password`（Zod 默认剥离未知字段），`db.user.create` 不写角色字段——**天然不接受 `role` 提权参数，需加静态断言防后续改动** |
| 测试入口与夹具 | `package.json` / `tests/*` | `test` 脚本显式罗列测试文件；`products/pipeline/queue/migration` 四个夹具插入固定 `composition_id='product-launch'` 临时行 |

### 1.2 差距清单（本次「补全」的对象）

| 编号 | 差距 | 影响 |
|------|------|------|
| G-01 | 无管理端：全量列表、搜索、筛选、分页 | 运营看不到停用模板与引用情况，只能查库 |
| G-02 | 无启停接口 | `enabled` 只能靠 SQL 改，PRD 第 4 章「模板启停」未落地 |
| G-03 | 展示元数据硬编码 | 中文名/描述/tone 在 `route.ts` 的 `DISPLAY`，英文名/CTA 在 `template-display.ts`，改一个字要发版 |
| G-04 | 分类不可管理 | `category` 为自由字符串，无字典、无排序、无筛选 |
| G-05 | 缩略图字段空转 | `thumbnail_path` 已有但无上传/读取/展示，前台用 CSS 示意图（验收报告遗留项） |
| G-06 | 无管理员角色 | PRD 定义「管理员：管理模板和用户」，但 `users` 表无 role，`resolveUserId` 只返回 user UUID，`/api/me` 不返回角色 |
| G-07 | 无操作审计 | 谁在何时改了什么、为何停用，无留痕、不可回滚 |
| G-08（r3 修正） | **夹具与种子行冲突** | `tests/{products,pipeline,queue,migration}.test.ts` 插入固定 `composition_id='product-launch'` 临时行，与 `003_seed_templates.sql` 种子行同值；加唯一约束后 `before` 钩子直接失败。**不能用随机 id 规避**（`createVideoJob` 要求命中封闭注册表） |
| G-09 | 停用后影响面未定义 | 前台 5min 缓存、已提交任务、`retry`（不回查模板）与 `regenerate`（走 `createVideoJob`）行为不同，r2 误写为「一律拒绝」 |
| G-10 | 无「至少一套可用」守卫 | 全部停用后新用户无法创作，仅前台空态文案，无服务端拦截 |
| G-11 | 无管理员账号生命周期管理 | 角色如何授予、撤销、名单、留痕、离职回收均无机制；若用裸 SQL 可能把管理员撤到 0 人锁死后台 |
| G-12（r2） | 无管理员账号页面，且存在自助提权面 | 只走脚本则非技术同事无法自助；若直接开页面并加「改角色」按钮，任何单个 admin 都能改自己或给备用账号提权 |
| **G-13（r3 新增，评审批注 B3）** | **启用数守卫未排除注册缺失行** | 代码发版移除 Composition 后，DB 行仍 `enabled=true` 并占用计数名额；管理员可停用最后一个真正可渲染模板，前台过滤后返回空列表，全站无法创作 |

### 1.3 既有约束（设计必须兼容，不轻易推翻）

- `video_jobs.template_id` → `video_templates.id` 外键：`Product` 删除有关联任务会被拒，模板同理应禁止删除。
- `getTemplate()` 的 fail-closed：任何「DB 里有但注册表没有」的模板不得进入渲染，也不得被启用；**测试夹具因此不能用随机 `composition_id`**（`src/lib/jobs.ts` 的 `createVideoJob` 要求注册表命中）。
- 用户侧 `GET /api/templates` 的响应字段（`TemplateDto`）被 3 个页面消费，只增不删；`src/lib/client/api.ts` **不处理 `If-None-Match`/304**，加 ETag 无消费方（r3 删除该要求）。
- `tests/ui-audit.test.ts` 断言 templates 页必须出现 `displayFor(template.compositionId)` / `display.englishName` / `display.cta`，删除 `TEMPLATE_DISPLAY` 映射时必须同步改断言。
- 生产鉴权为 Supabase JWT + `PV_AUTH_MODE=local` 的签名 Cookie；JWT payload 里的 `role` claim 定义了但**从未使用**，且客户端不可信。
- `src/shared/api.ts` 的 `ErrorCode` / `src/lib/errors.ts` 的 `httpStatusFor()` 需同步扩展才能返回新增的 409/角色类错误码，否则统一包络会落到 500。
- `src/lib/job-state.ts` 的 `retryJob` 不回查模板；`regenerateFromCompletedJob` 走 `createVideoJob` 会校验 enabled——**两者停用后的行为不同，不可合并表述**。
- 登录目前是本地开发会话，生产接 Supabase Auth 尚未落地（UI 审核遗留 C-04）；`users` 表无 `auth.users` 自动建行机制，JWT 路径只验签返回 `sub`，`/api/me` 查不到行即 401（见 §11.1 阻塞依赖）。**本期只做「角色层」的账号页**，不做业务用户后台（§8.2.6）。

---

## 2. 目标、范围与成功指标

### 2.1 目标与指标口径

| 指标 | 定义与口径 | 建议目标 | 来源 |
|------|------------|----------|------|
| 模板配置发版依赖次数 | 统计周期内「仅为改模板展示名/描述/分类/启停而触发的应用发版」次数 | 0 次 | 建议目标，待确认 |
| 模板配置生效时延 | 管理端保存成功时间 → 前台 `GET /api/templates` 返回新值的时间差（P95） | ≤ 60s | 由 3 个页面的 `ttlMs` + 主动失效保证；本期用审计表时间戳离线核算 |
| 不可渲染模板提交拦截率 | 因「未注册 compositionId / 已停用」被 `POST /api/videos` 拒绝的请求数 ÷ 同类请求数 | 100%（不允许漏放） | 现有 `jobs.ts` 守卫 + 新增用例 |
| 可用模板数 | `enabled = true` **且** `composition_id ∈ TEMPLATES` 的行数 | 恒 ≥ 1（服务端守卫） | 硬约束，r3 明确排除注册缺失行 |
| 管理员数 | `users.role='admin'` 的行数 | 恒 ≥ 1；页面提权前置 ≥ 2 | 硬约束（r2） |
| 管理操作留痕率 | 写操作产生 `template_audit_logs` 记录数 ÷ 管理端写操作总数 | 100% | 审计与主操作同事务 |
| 角色变更留痕率 | 产生 `user_role_audit_logs` 记录数 ÷ 角色变更总次数（`source=web` 与 `script` 全量计入） | 100% | 复核事务 + bootstrap 脚本强制写入 |
| 提权双人复核覆盖率 | 经复核单由**另一名** admin 批准而生效的提权数 ÷ 全部 Web 侧提权成功数 | 100% | `user_role_change_requests` 状态与 `reviewed_by` |
| 自助提权拦截率（观测） | 被 L2/L3 阻断的写角色请求数 ÷ 全部写角色请求数 | 仅观测，不设目标值 | **r3 改**：由限流/守卫的结构化告警日志与审计表离线核算，不依赖埋点 SDK |

> 上述为产品侧建议目标值，非实测数据；上线前需用真实基线校准。「提权成功数」分母排除 bootstrap/灾备脚本（`source=script`），两者口径不混算。

### 2.2 范围（MoSCoW）

**Must（V1.1 MVP，本次交付）**：管理端全量列表/搜索/筛选/分页、展示元数据编辑、启停（含「只数可渲染行」的至少一套守卫）、分类筛选与排序调整、缩略图上传与前台消费、注册表同步（含注册缺失自动停用）、管理员角色与服务端鉴权、操作审计（同事务）、停用后存量任务与缓存策略、存量数据迁移与夹具改造；**管理员账号子页（只读成员列表 + 提权申请/复核 + 降权 + 角色变更审计）**、**自助提权四层防护**、**提权双人复核流程**、**运维脚本保留为首个管理员 bootstrap 与灾备通道**。

**Should**：启停/覆盖类危险操作二次确认、审计 before/after 可视化、**模板引用任务数展示（r3 由 Must 降级，S1）**、停用原因填写、**待复核顶部红点**（S3 的具体形态）、提权申请 24h 到期提示、密码二次验证（依赖生产 Auth 方案，条件项）。

**Could**：模板使用分布看板、按模板分组的渲染失败率、管理员名单定期核对报表。

**Won't（显式不做）**：用户自定义 Remotion 代码 / 可视化时间轴编辑器、草稿→发布两态与灰度、版本回滚、模板市场/多租户私有模板、模板级计费与额度差异、AI 生成模板、模板 A/B 实验、模板 DELETE 接口；业务用户后台（额度调整、账号停用/删除、用量统计、用户画像）；多角色 RBAC / 超级管理员层级；多级审批链；任何单步写 `role=admin` 的 Web 接口；**应用埋点 SDK 与事件上报基础设施（r3 新增，S2）**；**消息推送 / 邮件通知（r3 新增，S3）**；**定时任务基础设施（r3 新增，D2）**；**`ETag` / `If-None-Match`（r3 新增，D5，无消费方）**。

### 2.3 关键假设（可推翻，需评审确认）

- A1：「补全」= 落地 PRD 第 4 章「模板列表、模板分类、模板启停」，并补齐运营可配置能力；不含自定义模板开发。
- A2：V1.1 角色仅 `user` / `admin` 二值，管理员同时可使用前台创作，不做复杂 RBAC；角色变更走管理端双人复核 + 脚本 bootstrap/灾备，不引入第三态角色。
- A3：模板为全站共享资源，无用户/租户维度的数据隔离；隔离边界只作用于「谁能写」。
- A4：缩略图由运营上传静帧（或后续用渲染链路生成），管理端不做实时 Remotion 预览。
- A5：本期沿用 `enabled BOOLEAN` 作唯一开关，不新增 `status` 状态字段，避免改动 `jobs.ts` 与队列测试的既有条件。
- A6（r2 微调，r3 补搜索口径）：普通用户账号的**管理动作**不在本期；为选择提权目标，管理端允许**只读**列出用户最小字段（id/email/role/createdAt），**默认精确 email 匹配 + 10 次/分限流（Q6）**，这是「成员选择器」而非用户管理后台。生产接入 Supabase Auth 后，业务用户后台另立需求。
- A7（r2）：首个管理员与灾备恢复由运维脚本授予；初始化时一次性授予**主/备 2 名不同账号**，否则页面提权功能冻结。
- **A8（r3 新增，Q7）**：本期管理端以 `PV_AUTH_MODE=local` 为前提。若生产走 Supabase JWT，须先定义 `auth.users` → `users` 行同步方式，否则 `requireAdmin` 对所有请求 401。
- **A9（r3 新增，Q8）**：`retry` 是对已扣费失败任务的补偿，不受模板停用影响；`regenerate` 属于新建任务，仍受 `enabled` 守卫约束。

### 2.4 r2 需求变更评估（Q2 拍板记录）

| 变更请求 | 影响范围 | 工期变化（估算） | 成本变化（估算） | 风险变化 | 干系人 | 结论 |
|----------|----------|------------------|------------------|----------|--------|------|
| 管理员账号管理页纳入本期 | §2 范围、§5 FR/TC、§6 数据、§7 API、§8 权限、§9 状态机、§10~§13 全链路 | 相对 r1 增加约 30%~40%（估算，待研发确认） | +1 页面、+7 接口、+1 复核单表、+约 8 条自动化用例 | 引入 PII 可见面、复核流程卡死、越权面扩大 | 产品、后端、前端、测试、运维 | **纳入当期** |
| 自助提权防护纳入本期 | 同上，另需 `ErrorCode`/`httpStatusFor`/`npm test` 三处同步 | 已计入上项 | 已计入上项 | 显著降低单人提权风险；残余「合谋」接受 | 后端、安全、测试 | **纳入当期** |

### 2.5 r3 变更评估（评审反馈）

| 变更请求 | 类型 | 影响范围 | 工期/成本变化（估算） | 风险变化 | 结论 |
|----------|------|----------|----------------------|----------|------|
| B1~B4 四个阻塞项修订 | **口径/依赖修正**（不新增功能） | §1/§4/§5/§6.2/§8.1/§9/§11.1/§12/附录 A | 基本持平；夹具改造约 +0.5 人日（估算） | 消除「测试必红」「全站无法创作」「生产 401」三类上线故障 | **纳入当期** |
| B2 `retry` 口径、D4 审计事务口径 | **行为口径变更** | FR-09/FR-12、TC-04、§7.3、§8.2.3、§9、§10 | 持平（少一个分支） | 消除文档内部自相矛盾 | **纳入当期，待 Q8/Q9 签字** |
| S1~S3 范围收缩 | **范围缩减** | §2.2、§5 FR-02、§6.4、FR-17、§11.1 | 相对 r2 减少约 15%~20%（估算） | 降低从 0 到 1 的隐性工作量；但需保留审计表支撑最小复盘能力 | **纳入当期（S2 部分采纳）** |
| D3 成员搜索收紧 | **安全加固** | FR-15、§7.2、§8.3、§13.1 Q6 | 持平 | 降低邮箱枚举风险 | **纳入当期（部分采纳，见附录 C）** |

> 逐条决策（采纳 / 部分采纳 / 确认）与修订落点见**附录 C：r3 评审反馈决策表**；评审要求的「拍板项」集中列在 §13.1，r3 暂按评审建议默认落地，待评审签字。

---

## 3. 方案对比与选型

| 维度 | 方案 A：配置即代码 | **方案 B：渲染契约在代码 / 运营元数据在 DB（推荐）** | 方案 C：全量 DB 驱动 |
|------|--------------------|------------------------------------------------------|----------------------|
| 思路 | 元数据继续放 `TEMPLATES` / 常量，DB 只保留 `enabled`，后台仅做启停 | 代码保留 `compositionId`/规格/`defaultProps`；DB 承载展示名、描述、CTA、tone、分类、排序、缩略图、启停；管理端 CRUD + 权限 + 审计 | 连 compositionId、时长、规格、默认 props 都进 DB，运行时动态解析 |
| 实现成本 | 低 | 中高 | 高 |
| 开发复杂度 | 低 | 中高（1 次迁移 + 约 16 个接口 + 2 个管理页 + 1 个 bootstrap 脚本 + 1 条提权复核流 + 夹具改造；r3 收缩埋点/通知后净持平） | 高（渲染契约跨 Web/Worker 动态化） |
| 运营体验 | 差：改文案仍要发版，不满足目标 | 好：不发版完成上架/下架/改文案/换图；管理员账号也可在页面受控管理 | 好，但配置项过多、误操作面大 |
| 风险 | 低，但 G-03/G-05/G-07 不解决 | 中：一次性存量迁移 + 缓存失效 + 权限链路；可测可控 | 高：破坏 `getTemplate()` fail-closed、快照与运行时契约可能漂移，逼近「任意代码执行」红线 |
| 上线时间 | 快 | 中 | 慢 |
| 结论 | 备选（仅当本期只做启停） | **推荐** | 不采用 |

**推荐理由**：B 用最小改动闭合 PRD 未落地项，且把「必须随代码发版的渲染资产」与「必须运营可改的展示资产」分开，各自只有一个真源；同时保留 `getTemplate()` fail-closed 与 `input_json` 快照机制，不触碰渲染链路的安全边界。r3 后账号生命周期、审计一致性、注册缺失守卫均在同一套「服务端查库 + 事务 + 守卫」框架内闭环。

**演进路径**：V1.1（本期，直接编辑即生效 + 审计留痕 + 提权双人复核）→ V1.2 引入草稿/发布两态与版本快照，触发条件为「出现 ≥2 次因误改元数据导致的线上回滚」或「模板数 > 10」；管理员 > 3 人时可评估多级审批或角色分级；埋点 SDK / 推送通知待基础设施就绪后另立需求 → V1.3 再评估模板级灰度与 A/B，触发条件为「模板选择转化率成为核心运营指标且已有实验平台」。

---

## 4. 总体设计：两层单一真源

### 4.1 分层原则

| 层 | 唯一真源 | 内容 | 变更方式 | 消费方 |
|----|----------|------|----------|--------|
| 渲染契约层（代码） | `src/shared/template.schema.ts` 的 `TEMPLATES` | `compositionId`、分辨率/fps、`durationSec`、`defaultProps`、组件绑定 | 代码发版 + 回归 | Web 提交校验、Worker 渲染、Remotion |
| 运营元数据层（DB） | `video_templates` 行 | `displayName`/`englishName`/`description`/`cta`/`tone`/`category`/`sortOrder`/`thumbnailPath`/`enabled` | 管理端（管理员） | `GET /api/templates`、管理端、前台卡片 |
| 权限主体层（DB） | `users.role` + `user_role_change_requests` + `user_role_audit_logs` | 角色二值、提权复核单、变更留痕 | bootstrap 脚本 / 已批准复核单事务 / 降权事务 | `requireAdmin`、管理端账号页、审计查询 |

**关联键**：`composition_id` 唯一，DB 行 1:1 绑定一条注册表记录；DB 的 `duration_sec` 视为「渲染契约的只读镜像」，管理端不开放编辑，由同步动作回填并加一致性守卫。

### 4.2 数据流（目标态）

```
代码发版：TEMPLATES 注册新 Composition
   ↓ 管理端点「从注册表同步」（含注册缺失行自动停用）
video_templates 新增行（默认停用、展示元数据待补全）
   ↓ 管理员补全元数据 + 上传缩略图 + 启用
GET /api/templates 只返回 enabled ∧ 注册表命中 的行（按 sortOrder）
   ↓ 前台选择 → /create?templateId=
POST /api/videos → 服务端二次校验 enabled ∧ getTemplate() 命中 → input_json 快照

权限侧（r2）：运维脚本 bootstrap 主/备 2 名 admin
   ↓ admin A 发起提权申请（不能给自己）
   ↓ admin B 复核批准（B ≠ A）
users.role 变更 + user_role_audit_logs 留痕（事务内）
```

即：**删除 `route.ts` 的 `DISPLAY` 常量与前端 `TEMPLATE_DISPLAY` 映射，全部改由 DB 字段下发**（同步修改 `tests/ui-audit.test.ts` 断言，见 §6.2 步骤 6）；未知/缺字段时用中性兜底值（不回退成内部 id，沿用 P1-6 约束）。

### 4.3 一致性守卫（fail-closed，不允许静默兜底）

- 注册表有、DB 无 → 管理端显示「待同步」，前台不展示。
- DB 有、注册表无 → 管理端标记 `registryMissing` 并禁止启用；前台不展示；不自动删除（保留历史任务 FK）。
- **DB 有、注册表无且 `enabled=true`（r3 新增，B3）→ 同步动作自动置 `enabled=false` 并写审计 `action=auto_disabled_registry_missing`**，避免这些行永久占用「启用数」名额。
- 同名 `composition_id` 多行 → 迁移阶段归并 + 唯一约束，之后不再依赖 `GET` 去重逻辑（可保留为防御性代码）。
- `duration_sec` 与注册表不一致 → 同步动作以注册表为准回填，并写审计。
- `users.role` 与复核单状态不一致 → 以 DB 角色为准判定权限；复核单仅作为「写入路径凭据」，不参与 `requireAdmin` 判定。
- **「可用模板数」计数条件恒为 `enabled=true AND composition_id ∈ TEMPLATES`**，任何停用守卫、看板指标、前台空态判断都不得只数 DB 行（B3）。

---

## 5. 功能拆解与验收标准

> 状态词：必须 = shall，应该 = should，可以 = may，禁止 = must not。编号与附录 RTM 对应。

| 编号 | 模块 | 功能需求（shall） | 优先级 |
|------|------|-------------------|--------|
| FR-01 | M1 列表 | 管理端展示全量模板（含停用），支持 keyword（名称/内部 id 不暴露给普通用户）、category、enabled 筛选与分页 1~100 | Must |
| FR-02（r3 改） | M1 列表 | 每行展示启用状态、分类、时长、排序值、缩略图、注册状态；**关联任务数降为 Should**（S1，避免每行 `COUNT(*)` on `video_jobs`） | Must（关联任务数 Should） |
| FR-03 | M2 编辑 | 可编辑 `displayName(≤120)` / `englishName(≤120)` / `description(≤300)` / `cta(≤60)` / `tone(枚举)` / `sortOrder(0~999)`；**禁止**编辑 `compositionId`、`durationSec`、`config` 渲染参数 | Must |
| FR-04 | M3 启停 | 独立动作接口启用/停用；停用时填写原因（选填）；写审计并主动失效前台缓存 | Must |
| FR-05（r3 改） | M3 启停 | 系统必须保证「**注册表命中且** `enabled=true`」的模板数 ≥ 1；停用守卫的计数必须带注册命中条件，不得只数 DB 行；最后一个可渲染模板禁止停用 | Must |
| FR-06 | M4 分类 | 分类用固定代码枚举（`launch/highlight/sale/showcase`），管理端可按分类筛选与批量调整 `sortOrder`；分类本身不开放 CRUD | Must |
| FR-07 | M5 缩略图 | 支持上传/替换缩略图，复用 `src/lib/upload.ts` 校验；前台卡片优先展示缩略图，缺失时降级为现有 CSS 示意 | Must |
| FR-08（r3 改） | M6 同步 | 「从注册表同步」只新增缺失 `composition_id` 行（默认停用），不覆盖已编辑元数据；**检测到 `registryMissing` 且 `enabled=true` 时自动停用并写审计 `auto_disabled_registry_missing`**；返回新增/跳过/自动停用/异常清单 | Must |
| FR-09（r3 改） | M7 审计 | 每次写操作记录 actor、action、before/after JSON、时间、原因；管理员可查；**审计与主操作同一事务，写失败整笔回滚并返回 500**（模板与角色口径一致） | Must |
| FR-10（r3 补） | M8 权限 | 全部 `/api/admin/**` 必须服务端校验 `users.role='admin'`；未登录 401、非管理员 403；服务端不得信任 JWT 的 `role` claim；**JWT 合法但 `users` 行不存在 → 401「账号未初始化」**，与 `/api/me` 的 401 语义一致 | Must |
| FR-11 | M9 前台 | `GET /api/templates` 响应只增字段（新增 `displayName/englishName/cta/sortOrder/thumbnailUrl`），保持 `TemplateDto` 旧字段可用；排序改 `sortOrder`；**不加 ETag**（D5） | Must |
| FR-12（r3 改） | M9 存量 | 停用后：已提交任务与 **`retry` 不受影响**（`retryJob` 不回查模板，快照自包含 compositionId + props，且是已付费失败任务的补偿）；**新提交 `POST /api/videos` 与 `regenerate`（走 `createVideoJob`）被 `enabled` 拒绝**并返回明确文案 | Must |
| FR-13 | M10 角色 | 管理员账号生命周期：首个/灾备管理员由受控运维脚本 bootstrap（写审计、禁自我提权、禁裸 SQL）；日常授予/撤销走管理端账号子页；所有变更 100% 留痕 | Must |
| FR-14 | M8 权限 | 管理端接口与页面均需服务端 gate；角色撤销后**下一次请求**即失效（不缓存 role）；所有 admin 路由必须调用 `requireAdmin` 并纳入静态守卫 | Must |
| FR-15（r3 补） | M11 账号页 | 只读成员列表（id/email/role/createdAt），支持 **email 精确匹配（Q6 默认）**、role 筛选与分页 1~100；**接口限流 10 次/分**（复用 `src/lib/rate-limit.ts`），查询行为写结构化告警日志；禁止返回 `passwordHash`、`quotaLeft`；不提供新建/删除/停用用户接口 | Must |
| FR-16 | M12 自助提权防护 | 四层防护：L1 查库 + 页面 gate + 静态守卫；L2 字段/动作白名单（**无单步写 `role=admin` 的 Web 接口**）；L3 禁改自己、提权需 admin 数 ≥2、降权后 ≥1、reason 必填 + 二次确认；L4 双人复核 + 24h 过期 + 审批人与发起人不同 | Must |
| FR-17（r3 改） | M12 提权复核 | 授予 admin 必须生成复核单，由**另一名** admin 批准后在同一事务内生效；**批准用条件更新 `updateMany({where:{id, role:"user"}})` 并断言 `count===1`**（D1），复核时重查发起人/目标当前状态；同一 target 仅 1 条 pending；**列表按 `expires_at > now()` 过滤并在读取时置 `expired`，不依赖定时任务**（D2）；批准后写入审计 + 「待复核 Tab 顶部红点」提示，**不做推送**（S3） | Must |
| FR-18 | M12 降权 | 撤销 admin 走独立接口（`role` 仅允许 `user`）：禁改自己、管理员数 ≥1 条件更新、reason 必填、二次确认输入目标邮箱；角色审计与角色更新**同一事务**，写失败整笔回滚 | Must |

**关键验收标准（Given/When/Then，可直接引用为测试用例）**

- **TC-01（FR-05）**：Given 全站仅 1 套**可渲染**启用模板，When 管理员调用停用接口，Then 返回 409 `TEMPLATE_LAST_ENABLED`，DB `enabled` 不变，审计不产生成功记录。
- **TC-02（FR-10，r3 改）**：Given 普通用户已登录并**伪造 JWT `role=admin` claim**，When 调用 `PATCH /api/admin/templates/{id}`，Then 403、DB 无变化。注：`X-Dev-User-Id` 仅在 `NODE_ENV !== "production"` 生效且会被当作真实身份，**不得在生产用例中使用**；生产 fail-closed。
- **TC-02b（FR-10，r3 新，B4）**：Given 合法 Supabase JWT 但 `users` 表无对应行，When 调用任一管理接口，Then 401「账号未初始化」，不泄露管理端数据。
- **TC-03（FR-03/11）**：Given 管理员修改 `displayName` 与 `sortOrder` 并保存，When 调用 `GET /api/templates`，Then 返回新值且按 `sortOrder` 升序；旧字段 `label/description/tone` 仍存在且同步为新值。
- **TC-04a（FR-12，r3 改）**：Given 模板 T 已停用且存在历史 completed 任务，When 用户对该任务调用 `regenerate`，Then 返回「模板已停用，请改用其他模板」，不新建任务、不扣额度；历史任务仍可播放/下载。
- **TC-04b（FR-12，r3 新，B2）**：Given 模板 T 已停用且存在 `failed` 任务（已扣额度、快照自包含），When 用户调用 `retry`，Then 重试成功回到 `pending`、按既有口径扣额度，**不因运营下架而失效**。
- **TC-05（FR-08）**：Given 已编辑过展示元数据的模板 A 与注册表中新增的 Composition B，When 执行同步，Then A 的元数据不变、B 新增一行且默认停用，前台列表不出现 B。
- **TC-06（FR-07）**：Given 上传 `evil.svg` 或改扩展名的可执行文件，When 调用缩略图上传，Then 400 且 `fields.file` 带原因，原缩略图不变。
- **TC-07（FR-04 并发）**：Given 两名管理员同时停用同一套模板且带过期 `updatedAt`，When 并发提交，Then 先到者 200、后到者 409 `TEMPLATE_CONFLICT` 并提示刷新，审计只记录 1 次成功停用。
- **TC-08（FR-01/02）**：Given 存在 2 条 `composition_id` 未注册的历史行，When 打开管理端列表，Then 两行标记 `registryMissing` 且「启用」按钮禁用，前台不展示这两行。
- **TC-09（FR-14）**：Given 某账号原为 admin 且持有有效会话，When 其角色被撤销为 user 后再次调用任意管理接口，Then 403（无需重新登录）；`/api/me.role` 变为 `user`。
- **TC-10（FR-13/18）**：Given 全站仅 1 名 admin，When 通过页面或脚本撤销该账号角色，Then 409 `ROLE_LAST_ADMIN` / 脚本非零退出，DB 不变、不写成功审计。
- **TC-11（FR-13/17）**：Given 一次成功的页面提权，When 查 `user_role_audit_logs`，Then 存在且仅存在 1 条记录，含 `source=web`、`actor_user_id`、target、from/to、reason、`request_id`、时间；重复批准同一复核单不产生第二条成功审计。
- **TC-12（FR-14/16）**：Given 新增了一个 `/api/admin/**` 路由，When 运行静态守卫用例，Then 未调用 `requireAdmin` 的路由被断言拦截；且断言不存在任何可将 `role` 直接写为 `admin` 的单步接口；普通用户直输管理页 URL 被服务端 gate 拦下。
- **TC-13（FR-16）**：Given 普通用户已登录并伪造 JWT `role=admin`，When 调用任一 `/api/admin/users/*` 接口，Then 403，成员列表数据不出现在响应中。
- **TC-14（FR-16/18）**：Given admin A，When A 尝试把**自己**提为 admin 或降为 user（任何写自己角色的路径），Then 403 `ROLE_SELF_CHANGE`，DB 不变。
- **TC-15（FR-16）**：Given 登录/注册接口，When 请求体携带 `role:"admin"` 或 `isAdmin:true`，Then Zod 剥离未知字段、`db.user.create` 不写角色，新建账号仍为 `user`；静态断言断言 create 参数不含 role。
- **TC-16（FR-16）**：Given admin A，When 直接调用 `PATCH /api/admin/users/{id}/role` 且 body `role:"admin"` 或调用任何无复核单的提权路径，Then 400 `ROLE_DIRECT_GRANT_FORBIDDEN`，`users.role` 不变、无成功审计。
- **TC-17（FR-17）**：Given admin A 为账号 C 提交提权申请，When A 自己批准 → 403 `ROLE_APPROVER_CONFLICT`；改由 admin B 批准 → 200，C 变为 admin、复核单 `approved`、审计 1 条，且 `reviewed_by=B ≠ requested_by=A`。
- **TC-18（FR-17/A7）**：Given 全站仅 1 名 admin，When 打开账号页或调用提权申请接口，Then 提权入口禁用 / 409 `ROLE_NEEDS_SECOND_ADMIN`；运维脚本 bootstrap 第二名（不同账号）后入口恢复，脚本写 `source=script` 审计。
- **TC-19（FR-17）**：Given 一条 pending 提权申请已超过 24h，When 调用批准，Then 409 `ROLE_REQUEST_EXPIRED` 且状态置 `expired`；对同一 target 重复提交申请 → 409 `ROLE_REQUEST_CONFLICT`。
- **TC-20（FR-18）**：Given 两名 admin 并发互相撤销，Then 条件更新保证最终 admin 数 ≥1（先到 200、后到 409）；另 Given **模板或角色**审计写入失败，When 执行任一写操作事务，Then 整笔回滚，业务表不变（D4）。
- **TC-21（FR-05/08，r3 新，B3）**：Given 模板 A `enabled=true` 但代码发版移除了其 Composition，且全站仅剩 1 套真正可渲染的启用模板，When 执行同步，Then A 自动停用并写审计 `auto_disabled_registry_missing`；随后停用最后一套可渲染模板 → 409，前台仍有 1 张卡片。
- **TC-22（FR-17，r3 新，D1）**：Given 针对同一 target 先后产生 2 条复核单并被不同审批人并发批准，When 并发提交，Then 条件更新保证仅 1 次生效（另一次 409 `ROLE_REQUEST_CONFLICT` 或幂等返回），审计仅 1 条，`reviewed_by` 与实际生效路径一致。
- **TC-23（FR-17，r3 新，D2）**：Given 一条 `status='pending'` 但 `expires_at ≤ now()` 的复核单，When 打开待复核列表（无定时任务），Then 该单显示为 `expired` 且不可批准，列表查询不返回可批准状态。

---

## 6. 数据设计

### 6.1 表结构变更（新增 `db/migrations/005_template_admin.sql`，全部幂等）

| 表 | 变更 | 说明 |
|----|------|------|
| `video_templates` | + `display_name VARCHAR(120)`、`english_name VARCHAR(120)`、`description VARCHAR(300)`、`cta VARCHAR(60)`、`tone VARCHAR(20)` | 承接 `DISPLAY` 与 `TEMPLATE_DISPLAY`；非空约束在回填后再加 |
| `video_templates` | + `sort_order INTEGER NOT NULL DEFAULT 0`（CHECK 0~999） | 前台排序口径 |
| `video_templates` | + `updated_at TIMESTAMPTZ DEFAULT now()`、`updated_by UUID`、`version INTEGER DEFAULT 1` | `version` 用于乐观锁（FR-04 并发） |
| `video_templates` | + `UNIQUE (composition_id)`、`CHECK (tone IN (...))` | 一致性守卫；加约束前必须先完成 6.2 归并 + 夹具改造 |
| `video_templates` | `category` 加 CHECK 限定 4 类代码 | 与 `TemplateDefinition.category` 枚举一致 |
| `users` | + `role VARCHAR(20) NOT NULL DEFAULT 'user'`（CHECK `user/admin`） | 管理员**唯一**判定依据；仅 bootstrap 脚本、已批准复核单事务、降权事务可写 |
| `template_audit_logs` | `id UUID PK`、`template_id UUID FK`、`actor_user_id UUID`、`action VARCHAR(32)`、`before_json JSONB`、`after_json JSONB`、`reason TEXT`、`created_at`；索引 `(template_id, created_at DESC)` | 与主操作**同一事务**；`template_id` 用 `ON DELETE RESTRICT`；`action` 新增枚举值 `auto_disabled_registry_missing` |
| `user_role_audit_logs` | `id`、`target_user_id`、`actor_user_id NULL`、`actor_label NULL`、`source` CHECK `web/script`、`request_id NULL`、`from_role`、`to_role`、`reason`、`created_at`；CHECK `actor_user_id IS NOT NULL OR actor_label IS NOT NULL` | 页面操作记 `actor_user_id + source=web + request_id`；脚本记 `actor_label`（工单号）+ `source=script`；**不记邮箱明文** |
| `user_role_change_requests` | `id`、`target_user_id`、`from_role`、`to_role`（本期仅 `admin`）、`requested_by`、`reason`、`status` CHECK `pending/approved/rejected/expired/cancelled`、`reviewed_by NULL`、`review_reason NULL`、`expires_at`、`created_at`、`decided_at`；CHECK `reviewed_by IS NULL OR reviewed_by <> requested_by`；部分唯一索引 `UNIQUE(target_user_id) WHERE status='pending'` | 提权双人复核凭据；**过期不依赖定时任务**，由列表查询按 `expires_at` 判定并在读取时置位（D2） |

> `prisma/schema.prisma` 同步补字段与三个 model；DDL 唯一真源仍是迁移脚本，禁止 `prisma migrate dev`；改 schema 后必须 `npm run prisma:generate`。

### 6.2 存量迁移方案（阻塞项，必须先在预发库演练）

| 步 | 动作 | 校验点 |
|----|------|--------|
| 0 | 备份 `video_templates` / `video_jobs` / `users`（`npm run backup`） | 备份文件可读性校验 |
| 1 | 扫描重复 `composition_id` 分组与孤儿引用 | 输出重复清单，人工确认保留行（建议保留 `created_at` 最早且被 `video_jobs` 引用最多的一行） |
| 2 | 事务内把 `video_jobs.template_id` 从被淘汰行重指到保留行，再删除被淘汰行 | 重指前后任务总数一致，无 FK 违规 |
| 3 | 回填新列：从 `DISPLAY` / `TEMPLATE_DISPLAY` / `003_seed_templates.sql` 一次性写入；`sort_order` 按原 `category` 顺序赋 10/20/30/40 | 4 行全部有值，与当前前台展示逐字一致 |
| 4 | 加非空/CHECK/唯一约束，建两张审计表与复核单表 | 重复执行迁移不报错 |
| 5 | **bootstrap 初始化**：受控脚本一次性授予**主/备 2 名不同账号**为 admin，不通过 Web 页面产生首个 admin、不用裸 SQL | `/api/me.role=admin`，`admin 数 ≥2`；`user_role_audit_logs` 有 2 条 `source=script` |
| 5b | 校验页面提权解锁条件：admin 数 ≥2 且两账号不同 | 账号页「申请设为管理员」可用；仅 1 名则入口冻结（TC-18） |
| 6（r3 补） | **夹具改造（§6.2.1）+ 同步修改 `tests/ui-audit.test.ts` 的 `displayFor`/`englishName`/`cta` 断言（M1）**；回归：`npm test` 全量 + `npm run migrate:check` + 前台 4 卡片 + 提交 1 个任务 + 提权复核闭环冒烟 | 全绿方可切流 |

**回滚**：向下脚本删除新列/约束/新表（保留备份），恢复 `GET /api/templates` 的 `DISPLAY` 兼容分支；前端用开关 `PV_TEMPLATE_ADMIN=0` 隐藏管理入口；角色回滚依据 `user_role_audit_logs` 精确还原，不整表重置。**注意（r3 修正）**：唯一约束加上后，冲突的是「夹具与种子行同值」，不是「并行夹具互插重复」，修复方案见 §6.2.1。

### 6.2.1 测试夹具改造（r3 新增，B1 阻塞）

代码核对：`tests/products.test.ts:36`、`tests/pipeline.test.ts:36`、`tests/queue.test.ts:33`、`tests/migration.test.ts:61` 均插入固定 `composition_id='product-launch'` 的临时行，与 `003_seed_templates.sql` 的种子行同值；加 `UNIQUE(composition_id)` 后这些 `before` 钩子直接失败。**不能用随机 `composition_id` 规避**：`src/lib/jobs.ts` 的 `createVideoJob` 要求 `getTemplate(compositionId)` 命中封闭的 4 个注册 id，需要提交任务的测试必须用真实注册 id。

| 方案 | 做法 | 结论 |
|------|------|------|
| **A 复用种子行（推荐）** | 夹具直接引用种子 UUID `11111111-1111-4111-8111-111111111111`，删掉 `before` 的 INSERT 与 `after` 的 DELETE；任务按该 id 创建 | 改动最小、不触碰注册表约束、无需恢复，且天然满足 `getTemplate()` |
| B 先删后插再恢复 | `before` 先删种子行、再插同 `composition_id` 临时行，`after` 删临时行并恢复种子 | 备选；事务与恢复逻辑复杂，中途失败会留下无模板环境 |

无论选哪种：逐一检查 4 个文件 `after` 钩子的 `DELETE FROM video_templates WHERE id=$1`，**禁止误删种子行**（方案 A 直接删除该语句）；`tests/migration.test.ts` 的迁移用例按测试意图单独评估（若只为验证迁移脚本，改在临时 schema / 事务内构造，或同样复用种子 id）。改造完成后以 `npm test` 全绿作为迁移放行门槛，并纳入 RK-01 应对。

### 6.3 关键字段口径

- `enabled`：布尔，唯一开关；**「可用模板数」= `enabled=true ∧ composition_id ∈ TEMPLATES`**，注册缺失行不计入且同步时自动停用（B3）。
- `sortOrder`：整数，升序；相同值按 `composition_id` 字典序兜底。
- `thumbnailPath`：受控相对路径 `thumbnails/{templateId}/{uuid}.{ext}`，禁止外部 URL / 绝对路径 / `..`；读取走鉴权接口，不静态暴露 `data/` 目录。
- `durationSec`：注册表只读镜像，管理端展示但不可改；口径为秒，`TEMPLATES` 中 15/20。
- `users.role`：`user` / `admin` 二值；管理员数恒 ≥ 1（所有写入路径守卫）；页面提权前置 ≥ 2。
- `user_role_change_requests.status`：只描述申请单状态，**不参与** `requireAdmin` 判定；`pending` 是否可批准由 `expires_at > now()` 决定。

### 6.4 数据能力与指标口径（r3 按 S2 收缩）

**本期最小数据能力（Must）**：不引入埋点 SDK / 事件上报基础设施，改由三张审计/复核表 + 只读视图支撑复盘：

| 复盘指标 | 数据来源 | 核算方式 |
|----------|----------|----------|
| 管理操作留痕率 / 角色变更留痕率 | `template_audit_logs` / `user_role_audit_logs` | 事务保证 1:1，离线 SQL 统计 |
| 提权双人复核覆盖率 | `user_role_change_requests`（status/reviewed_by/requested_by） | 批准的提权数 ÷ Web 侧提权成功数 |
| 配置生效时延 | `template_audit_logs.created_at` + 前台缓存失效日志 | 离线核算 P95 |
| 自助提权拦截 / 成员搜索限流 | **结构化告警日志**（复用现有日志与 `src/lib/rate-limit.ts`） | 按错误码/路由聚合，不进埋点 |

**V1.2 建议事件清单（本期不实现，待埋点基础设施就绪另立需求）**：`template_admin_update`、`template_enabled/disabled`、`template_thumbnail_uploaded`、`template_sync_run`、`template_selected`、`template_submit_rejected`、`admin_forbidden`、`admin_role_grant_requested/approved/rejected/expired`、`admin_role_revoked`、`admin_privilege_escalation_blocked`。所有角色类事件只记 UUID 与 requestId，不记邮箱明文；bootstrap 脚本不进应用埋点。

> 口径说明：`每个版本必须包含支撑复盘的最小数据能力（至少 1 个核心指标看板）`。本期以**审计表只读看板「模板启用状态与角色变更流水」**满足该要求，避免 S2 收缩后「上线无数据可复盘」。

---

## 7. API 契约

### 7.1 用户侧（保持兼容）

| 方法 | 路径 | 变更 |
|------|------|------|
| GET | `/api/templates` | 只增字段；仍只返回 `enabled ∧ 注册表命中`；排序由 `category` 改 `sortOrder`；**不加 `ETag`**（D5：`src/lib/client/api.ts` 无 `If-None-Match` 处理，加了无消费方）；缓存 TTL 由 5min 降至 60s，**落点为 `templates/create/videos` 三个页面的 `ttlMs`**，不改 `DEFAULT_STALE_MS`（M2）；主动失效同一 `cacheKey: "templates"` |
| GET | `/api/templates/[id]/thumbnail` | 新增：鉴权 + 受控路径读取；无缩略图返回 404，前端降级 CSS 示意 |
| GET | `/api/me` | `select` 增 `role` 并返回，仅用于前端是否显示管理入口；查不到 `users` 行时 401 口径与 `requireAdmin` 一致 |
| POST | `/api/auth/session` | 不变：`LoginSchema` 保持仅 `email/password`；显式 `.strict()` 并加静态断言，禁止新增 `role` 参数 |

### 7.2 管理侧（统一前缀，全部 `requireAdmin`）

**模板组**

| 方法 | 路径 | 说明 | 成功 |
|------|------|------|------|
| GET | `/api/admin/templates` | 全量 + 筛选 + 分页 + 注册状态（引用计数为 Should） | 200 |
| GET | `/api/admin/templates/[id]` | 详情（含审计摘要） | 200 |
| PATCH | `/api/admin/templates/[id]` | 白名单字段更新，需带 `version` 做乐观锁 | 200 |
| POST | `/api/admin/templates/[id]/enable` | 启用（要求注册表命中、必填元数据完整） | 200 |
| POST | `/api/admin/templates/[id]/disable` | 停用（要求**可渲染启用数 > 1**） | 200 |
| POST | `/api/admin/templates/[id]/thumbnail` | multipart 上传，复用 `upload.ts` | 200 |
| POST | `/api/admin/templates/sync` | 同步缺失行 + **自动停用注册缺失行并写审计** | 200（含新增/跳过/自动停用清单） |
| GET | `/api/admin/templates/[id]/audits` | 审计分页 | 200 |

**账号组（r2 新增，r3 修订）**

| 方法 | 路径 | 说明 | 成功 |
|------|------|------|------|
| GET | `/api/admin/users` | 只读成员列表：**email 精确匹配（Q6 默认）**、`role` 筛选、分页 1~100、限流 10 次/分；字段仅 id/email/role/createdAt | 200 |
| GET | `/api/admin/users/role-audits` | 角色变更审计分页 | 200 |
| GET | `/api/admin/users/role-requests` | 提权申请列表；**按 `expires_at > now()` 展示 pending，读取时批量置 `expired`**（D2）；发起人不可见自己申请的批准操作 | 200 |
| POST | `/api/admin/users/role-requests` | 提交提权申请 `{targetUserId, role:"admin", reason}`；目标须存在且为 user、不能是自己、admin 数 ≥2 | 201（pending） |
| POST | `/api/admin/users/role-requests/[id]/approve` | 另一名 admin 批准；事务内条件更新角色 + 写审计 + 关单 | 200 |
| POST | `/api/admin/users/role-requests/[id]/reject` | 驳回（reason 必填） | 200 |
| POST | `/api/admin/users/role-requests/[id]/cancel` | 发起人撤回（Should） | 200 |
| PATCH | `/api/admin/users/[id]/role` | **仅降权**：`{role:"user", reason}`；禁改自己、admin 数 ≥1 | 200 |

**禁止提供**：`DELETE /api/admin/templates/[id]`、用户新建/删除/停用接口、**任何单步写 `role=admin` 的 Web 接口**。r1 的「角色管理不提供 Web API」结论已被 r2 替换；r3 补：列表接口不得暴露可批准的过期单。

### 7.3 错误码（沿用统一包络 `{ok,data,error}`）

| 码 | HTTP | 场景 |
|----|------|------|
| `UNAUTHORIZED` | 401 | 未登录 / **JWT 合法但 `users` 行不存在（账号未初始化）** |
| `FORBIDDEN` | 403 | 非管理员（`errors.forbidden()` 已存在） |
| `VALIDATION_ERROR` | 400 | 字段超长/非法 tone/非法图片/非法 id/reason 缺失 |
| `TEMPLATE_CONFLICT` | 409 | `version` 过期（并发编辑） |
| `TEMPLATE_LAST_ENABLED` | 409 | 停用最后一套**可渲染**启用模板 |
| `TEMPLATE_NOT_REGISTERED` | 409 | 启用未注册 compositionId |
| `ROLE_SELF_CHANGE` | 403 | 尝试修改自己的角色 |
| `ROLE_DIRECT_GRANT_FORBIDDEN` | 400 | 绕过复核单直接请求 `role=admin` |
| `ROLE_APPROVER_CONFLICT` | 403 | 发起人批准自己的申请 |
| `ROLE_NEEDS_SECOND_ADMIN` | 409 | admin 数 < 2 时发起提权申请 |
| `ROLE_LAST_ADMIN` | 409 | 撤销后管理员数将为 0 |
| `ROLE_REQUEST_EXPIRED` | 409 | 复核单超过 24h / 读取时已置 expired |
| `ROLE_REQUEST_CONFLICT` | 409 | 同一 target 已有 pending / 状态已终态 / **并发批准条件更新 `count!==1`** |

> r3：**删除 `TEMPLATE_IN_USE`**（M3：不存在删除接口，无触发路径）。`src/shared/api.ts` 的 `ErrorCode` 是封闭常量且当前无任何 409 码，上表所有 409 及 `ROLE_*` 码必须同步扩展 `ErrorCode`、`httpStatusFor()`、`errors` 工厂；新增测试文件必须加入 `package.json` 的 `test` 脚本清单。

**幂等与并发**：启停用「目标态设置」；编辑用 `version` CAS；同步用唯一约束 + `ON CONFLICT DO NOTHING`；**所有写操作（模板与角色）统一在事务内完成「更新 + 审计 + version+1」，审计写失败整笔回滚并返回 500**（D4）。角色侧：降权用条件更新保证 admin 数 ≥1；批准用 `updateMany({where:{id, role:"user"}})` 断言 `count===1`（D1）+ 唯一 pending 索引 + 状态 CAS。

---

## 8. 权限矩阵与安全

### 8.0 权限矩阵

| 角色 | 前台读模板 | 前台创作 | 管理端列表/详情 | 编辑元数据 | 启停 | 上传缩略图 | 同步 | 查审计 | 查成员列表 | 改角色 |
|------|-----------|----------|-----------------|------------|------|------------|------|--------|------------|--------|
| 未登录 | ✗（401） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 普通用户 `user` | ✓ | ✓ | ✗（403） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 付费用户 `user` | ✓ | ✓ | ✗（403） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 管理员 `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（只读最小字段） | ✓（受约束） |
| 运维（产品外） | — | — | — | — | — | — | — | — | — | ✓（仅 bootstrap/灾备） |

- 管理员「改角色」四条约束：不能改自己；提权需另一名 admin 复核；降权后 admin 数 ≥1；提权前置 admin 数 ≥2。
- **代码层权限不在产品内**：谁能改 `remotion/*.tsx` 与 `TEMPLATES` 注册表，靠 Git 分支保护、Code Review、发版审批与部署凭据控制。
- **数据权限**：模板全局共享，无用户维度隔离；成员列表与审计表仅管理员/运维可查；所有写操作强制记录 actor。

### 8.1 鉴权实现落点（r3 修订）

| 落点 | 改动 |
|------|------|
| `db/migrations/005_template_admin.sql` / `prisma/schema.prisma` | 字段与三张表/model；`npm run prisma:generate` |
| `src/lib/admin.ts`（新增） | `requireAdmin(headers)`（返回 userId）+ `assertRoleChangeAllowed(...)`；**JWT 合法但无 `users` 行 → 401「账号未初始化，请联系管理员」** |
| `src/app/api/admin/{templates,users}/*` | 每个 handler 首行调用；统一 wrapper 防漏挂 |
| `.../role-requests/[id]/approve` | 唯一能把 `role` 写成 `admin` 的 Web 路径；**条件更新 + 四眼校验 + 同事务审计** |
| `src/app/(app)/admin/*` | 页面服务端 gate |
| `src/app/(app)/{templates,create,videos}/page.tsx` | 三处 `ttlMs` 由 5min 改 60s；**不改 `DEFAULT_STALE_MS`**（M2） |
| `src/app/api/me/route.ts` / `types.ts` / `AppShell.tsx` | `role` 展示字段 + 条件渲染管理入口 |
| `src/shared/api.ts` / `src/lib/errors.ts` | 扩展 `ErrorCode` / `httpStatusFor()` / `errors` 工厂 |
| `tests/{products,pipeline,queue,migration}.test.ts` + `tests/ui-audit.test.ts` | 夹具复用种子 id（§6.2.1）+ 同步改 `displayFor` 断言（M1） |
| `scripts/set-user-role.ts` + `package.json` | bootstrap/灾备脚本；新测试文件加入 `test` 清单 |

```ts
// src/lib/admin.ts
export async function requireAdmin(headers: Headers): Promise<string> {
  const userId = resolveUserId(headers);           // 未登录 → 401
  const user = await db.user.findUnique({
    where: { id: userId }, select: { role: true },
  });
  if (!user) throw errors.unauthorized("账号未初始化，请联系管理员");  // B4
  if (user.role !== "admin") throw errors.forbidden("仅管理员可操作后台配置");
  return userId;
}

// 批准提权：唯一能把 role 写成 admin 的 Web 路径
await db.$transaction(async (tx) => {
  await requireAdminInTx(tx, actorId);             // 每次重新查库
  const req = await tx.userRoleChangeRequest.findUnique({ where: { id } });
  assert(req?.status === "pending" && req.expiresAt > new Date());
  assert(req.requestedBy !== actorId);             // DB 层另有 CHECK 兜底
  assert(req.targetUserId !== actorId && req.toRole === "admin");

  // D1：条件更新替代「先 assert 再 update」，消灭无锁窗口
  const granted = await tx.user.updateMany({
    where: { id: req.targetUserId, role: "user" },
    data: { role: "admin" },
  });
  if (granted.count !== 1) throw roleConflict("目标角色已变更，请刷新后重试"); // 409

  await tx.userRoleAuditLog.create({ data: { source: "web", actorUserId: actorId,
    requestId: req.id, targetUserId: req.targetUserId,
    fromRole: "user", toRole: "admin", reason: req.reason } });
  await tx.userRoleChangeRequest.update({ where: { id }, data: {
    status: "approved", reviewedBy: actorId, decidedAt: new Date() } });
});  // 任一步失败 → 整笔回滚
```

**四条不信任**：① 不认 JWT `role` claim / Cookie / 请求头注入的角色，每次查库；② 不认前端隐藏入口，接口 + 页面双层 gate；③ 不提供任何单账号自助提权（登录/注册不接 `role`、不做首用户自动 admin、禁改自己、提权需另一名 admin 复核）；④ 不设「临时跳过鉴权」开关。**`X-Dev-User-Id` 仅在非生产生效**（M5）。副作用：角色撤销后下一次请求立即失效。

**权限之外的第二道约束**：即使管理员也不能改 `compositionId` / `durationSec` / `config`；启停必须走独立动作接口，避免误改渲染契约导致快照漂移。

### 8.2 管理员账号管理与自助提权防护

#### 8.2.0 术语与问题定义

| 术语 | 定义 |
|------|------|
| 自助提权 | 单个主体在**无需第二名管理员独立确认**的情况下，把自己或自己可控的账号提升为 admin。4 条路径：① 伪造角色声明；② 直接调用写角色接口；③ 把 `targetUserId` 填成自己；④ 给自己可控的备用账号（小号）提权 |
| 双人复核（four-eyes） | 申请人与批准人必须是**不同的 admin**，服务端校验 + DB `CHECK (reviewed_by <> requested_by)` 双保险 |
| bootstrap / 灾备通道 | 产品外的运维脚本，仅用于「从 0 到 1 初始化」与「管理员被撤到 0/1 人时恢复」，需工单号留痕 |

> **为什么必须做双人复核**：只做前三条，任何一名 admin 仍能给自己的小号提权（路径 ④）。双人复核是本期唯一能覆盖它的控制措施；残余「两名 admin 合谋」按 RK-12 接受并靠审计告警兜底。

#### 8.2.1 方案对比与本期结论

| 方案 | 思路 | 结论 |
|------|------|------|
| U1 裸运维 SQL | 直接 `UPDATE users SET role=...` | 不采用：无留痕、无守卫 |
| U2 受控运维脚本 | 脚本 + 审计 + ≥1 admin 守卫，无 Web UI | **保留，降级为 bootstrap / 灾备专用** |
| U3 账号子页（简单版） | 列表 + 授予/撤销按钮 | **不采用**：单人可直接提权，正是 Q2 要补的缺口 |
| **U4 账号子页 + 四层防护 + 双人复核** | 7 接口 + 1 页面 + 1 张表 | **本期采用** |

#### 8.2.2 页面信息架构与原型思路

```
/admin                          管理后台（服务端 gate）
├── /admin/templates            模板管理（列表/筛选/编辑/启停/同步/审计）
└── /admin/users                成员与角色
    ├── Tab 成员列表            精确 email 搜索 / role 筛选 / 分页；行内「申请设为管理员」「撤销管理员」
    ├── Tab 待复核              我可复核的申请（自己发起的不显示批准按钮；顶部红点提示待办）
    └── Tab 角色变更记录        只读审计
```

- 顶部常驻风险提示条（当前管理员数、提权需双人复核、少于 2 人时提权冻结说明）。
- 核心任务 ≤3 步：搜到目标账号 → 申请并填原因 → 另一名 admin 在「待复核」批准。
- 交互态：正常 / 空 / 加载 / 错误（403 无权限页、409 明确文案且保留表单）/ 边界（自己行无「撤销」、admin 数 =1 时「申请」禁用）。
- 二次确认：降权与提权申请均需弹窗，展示目标邮箱与当前→目标角色、必填原因；降权额外要求输入目标邮箱。**二次确认只是体验层，服务端独立校验全部守卫**。

#### 8.2.3 自助提权四层防护

| 层 | 控制措施 | 覆盖路径 | 失败结果 |
|----|----------|----------|----------|
| **L1 身份与入口** | `requireAdmin` 每次查 `users.role`、页面 gate、静态守卫、登录/注册 `.strict()` + 静态断言 | ① | 401 / 403 / 静态测试失败 |
| **L2 字段与动作白名单** | 唯一写 `role=admin` 的 Web 路径是已批准复核单事务；`PATCH .../role` 只接受 `user`；无新建/删除/批量/导入角色接口 | ② | 400 `ROLE_DIRECT_GRANT_FORBIDDEN` |
| **L3 主体约束** | 禁改自己、提权前置 admin ≥2、降权条件更新保证 ≥1、reason 必填、二次确认 | ③ | 403 `ROLE_SELF_CHANGE` / 409 `ROLE_LAST_ADMIN` / `ROLE_NEEDS_SECOND_ADMIN` |
| **L4 组织控制** | 双人复核 + DB CHECK + 24h 过期（列表读取时判定）+ 复核时重查双方状态 + **条件更新 `count===1`** + 待复核红点 + 审计同事务强写 | ④ | 403 `ROLE_APPROVER_CONFLICT` / 409 过期或冲突 |

**审计一致性（r3 按 D4 统一）**：模板审计与角色审计**都是同一事务、失败整笔回滚**。r2 中「模板审计写失败只告警不阻断」的差异段落已删除——模板只有 4 行，不存在高并发写审计的性能顾虑，少一个分支就少一个不一致点。

#### 8.2.4 提权复核流程与脚本契约

- **流程**：admin A 提交（`pending`，24h 有效）→ 待复核 Tab + 顶部红点提示其余 admin（**不做推送/邮件**，S3）→ admin B 批准（事务执行）/ 驳回 → 写审计；A 可撤回 pending 单。
- **过期（r3 按 D2）**：项目无定时任务基础设施，`GET /api/admin/users/role-requests` 按 `expires_at > now()` 过滤 pending，对已过期仍为 pending 的行在读取时批量置 `expired` 并以 `expired` 状态返回；列表不出现「可批准」的过期单。
- **并发与幂等**：部分唯一索引防重复申请；批准用条件更新 + 状态 CAS（D1），重复批准幂等返回 200 且不重复写审计；发起人在此期间被撤权 → 复核时重查其 `role`，非 admin 则拒绝批准。
- **bootstrap/灾备脚本**（`npm run admin:role`）：`--email` / `--role admin|user` / `--actor`（工单号）/ `--actor-email`（与 `--email` 相同则拒绝，防自我提权）/ `--reason`（灾备需含工单号）/ `--list`。事务内：读当前角色 → 校验变更后 admin 数 ≥1 → 更新 → 写 `user_role_audit_logs`（`source=script`）→ 提交；重复授予返回「无变更」不写成功审计；**仅允许在 admin 数 < 2 时授予 admin**，≥2 时拒绝脚本提权并提示走页面复核。脚本纳入 Git 与 Code Review。
- **日常口径**：离职/转岗回收走页面降权；回收后会话仍有效但下一次请求即 403；误操作依据审计 from/to 精确恢复；仅剩 1 名 admin 时页面提权冻结，脚本补齐备用账号后恢复。

#### 8.2.5 残余风险（明确接受）

两名管理员合谋仍可互相批准提权。本期按「接受 + 缓解」：待复核红点 + 角色变更 100% 留痕 + 运维每月 `--list` 核对名单 + 审计表纳入只读看板。出现合谋/误授予事件后再评估多级审批。

#### 8.2.6 业务用户后台为什么仍不做

登录目前是 `PV_AUTH_MODE=local`，生产接 Supabase Auth 尚未落地（C-04）。用户主体一旦切到 `auth.users`，用户管理 UI 的数据来源、字段与停用语义都会变。**本期账号页只读列出 4 个最小字段，仅用于选择角色变更目标**，不提供额度调整、账号停用、用量统计。PRD 第 4 章「后台管理」记为 Auth 方案确定后的独立需求。

### 8.3 其他安全要求

- **上传安全**：复用 `upload.ts` 三重校验 + 受控路径；响应带 `nosniff` 与 CSP。
- **PII 最小化（r3 补 D3）**：成员列表展示 email 为业务必要信息，仅 admin 可见；**搜索默认精确 email 匹配（Q6 默认）+ 10 次/分限流**，避免逐字母枚举全站邮箱；查询行为写结构化告警日志（非埋点 SDK），不记邮箱明文；不提供成员导出；审计/日志只记 UUID 与 requestId。
- **红线自检**：不提供任意代码执行入口；管理端文案不使用绝对化用语；示例数据全部虚构；Remotion 商用授权沿用既有风险项。

---

## 9. 状态流转

### 9.1 模板状态

| 状态 | 含义 | 允许操作 | 守卫 |
|------|------|----------|------|
| `未同步` | 注册表有，DB 无行 | 同步 | 仅代码发版可新增注册项 |
| `停用·待配置` | 同步生成的默认态 | 编辑元数据、上传缩略图、启用 | 启用要求：注册表命中 ∧ 必填元数据完整 |
| `启用` | 前台可见、可提交任务 | 编辑、上传、停用 | 停用要求：**可渲染启用数 > 1** |
| `停用·已下架` | 前台不可见，历史任务仍可追溯 | 编辑、重新启用 | 重新启用同「启用」守卫 |
| `注册缺失`（r3 补） | DB 有行但注册表无对应项 | 仅查看、审计 | **禁止启用**；同步时自动 `enabled=false` + 写审计；前台不展示 |

**停用影响面（FR-12 口径，r3 按 B2 修正）**：

| 对象 | 行为 |
|------|------|
| 已提交任务（pending/processing/completed） | 不受影响，`input_json` 快照自包含 compositionId + props |
| **`retry` 手动重试 failed/cancelled 任务** | **不受模板停用影响**：`src/lib/job-state.ts` 的 `retryJob` 只重置状态 + 扣额度，不回查模板；且这是已付费失败任务的补偿，运营下架不应让用户付费入口失效 |
| 新提交 `POST /api/videos` | 服务端 `enabled` 守卫拒绝；前端缓存未过期时可能短暂可见，提交时仍被拦截 |
| `regenerate` | 走 `createVideoJob`，被 `enabled` 拒绝；前端禁用按钮并提示「模板已停用，请改用其他模板」 |
| 历史任务展示 | 不回读模板元数据，避免改名后历史记录「变脸」 |
| 前台缓存 | 启停成功后主动 `invalidateAsyncCache("templates")`；3 个页面 `ttlMs` 降至 60s 兜底 |

### 9.2 角色变更申请状态机

| 状态 | 含义 | 允许操作 | 守卫 |
|------|------|----------|------|
| `pending` | 已发起、待另一名 admin 复核 | 批准（他人）、驳回、发起人撤回 | `expires_at > now()` 才在列表展示为可批准；审批人 ≠ 发起人；同一 target 仅 1 条 pending |
| `approved` | 已批准并生效 | 只读 | 事务内角色已变更 + 审计已写 + 单已关闭；重复批准幂等 |
| `rejected` | 被驳回 | 只读 | 记 `review_reason`；可重新发起 |
| `cancelled` | 发起人撤回 | 只读 | 仅发起人可撤回 |
| `expired` | 超过 24h 未处理 | 只读 | **列表读取时按 `expires_at` 判定并置位，不依赖定时任务**（D2）；不可再批准 |

**注意**：`users.role` 始终只有 `user/admin` 二值，`requireAdmin` 不读复核单状态，避免权限判定依赖第二张表产生漂移。

---

## 10. 异常与边界清单

| 类别 | 场景 | 期望处理 |
|------|------|----------|
| 空 | 无模板 / 筛选无结果 / 注册表无新增 / 无待复核 / 无成员匹配 | 空态文案 + 「同步注册表」入口；前台空态沿用「请联系管理员初始化模板数据」 |
| 错 | 非法 UUID、字段超长、非法 tone/category、`version` 过期、reason 缺失 | 400 / 409 中文明确提示 + `fields` 定位字段；不回传堆栈 |
| 界 | 缩略图超大、SVG、超长文本、sortOrder 越界、复核单过期 / 重复 pending / admin 仅 1 人 | 复用上传校验；文本按 Zod 上限拒绝；**过期单在列表显示 `expired` 不可批准**（D2）；提权入口冻结并提示走脚本 |
| 权限 | 未登录 / 非管理员 / 伪造 claim / 会话过期 / 角色被撤销 / 改自己 / 单人提权 / 自批 / 直接写 `role=admin` / **JWT 合法但 `users` 无行** | 401 / 403 / 400 明确文案；**JWT 有签名但无本地用户行 → 401「账号未初始化」**（B4）；前端 401 跳登录、403 无权限页 |
| 并发 | 双人同改、同时停用最后一套、重复点击启停、并发撤销 admin、**并发批准同一 target 的复核单** | `version` CAS + 条件更新（可渲染启用数 ≥1、admin 数 ≥1、target `role="user"`）+ 唯一 pending 索引 + 状态 CAS + 目标态幂等 |
| 依赖 | **模板或角色审计写失败** / 缓存失效失败 / 缩略图读取失败 | **审计写失败整笔回滚并返回 500**（D4）；缓存/缩略图失败记结构化告警、前台降级 CSS 示意 |
| 一致性 | DB 行注册缺失、`duration_sec` 不一致、复核单状态与 `users.role` 不一致 | 同步时自动停用注册缺失行并留痕；同步以注册表为准回填；权限判定一律以 `users.role` 为准 |
| 断网/离线 | 管理端保存失败 | 保留表单内容可重试；不产生半写入（事务） |

---

## 11. 上线计划、依赖与验证

### 11.1 依赖就绪度（三档）

| 依赖项 | 所属 | 分级 | 最晚就绪时限 | 影响与替代方案 |
|--------|------|------|--------------|----------------|
| `005_template_admin.sql` 迁移（归并 + 唯一约束 + 回填 + 两张新表） | DB | **阻塞** | 排期前 | 未就绪不得承诺排期；先在预发库演练 |
| `users.role` + `requireAdmin` + wrapper + 页面 gate + 静态守卫 | 后端 | **阻塞** | 联调前 | 缺失则管理接口全部不可上线；不设跳过鉴权开关 |
| **本期生产以 `PV_AUTH_MODE=local` 为前提（B4 / Q7）** | 后端/运维 | **阻塞** | 排期前 | 若生产走 Supabase JWT，须先定义 `auth.users` → `users` 行同步方式（Webhook 或首次登录 upsert）并保证 `role` 列落本库；否则 `requireAdmin` 对所有请求 401、账号页不可用、`admin:role` 脚本无处写 role |
| `scripts/set-user-role.ts` + `admin:role` script（含 ≥1 守卫） | 运维/DB | **阻塞** | 联调前 | 缺失则无法产生首个 admin；不得裸 SQL 替代 |
| 初始化主/备 2 名不同 admin（A7） | 运维 | **阻塞** | 联调前 | 仅 1 名时页面提权冻结 |
| 提权复核流程 + 账号子页 + 四层防护 | 后端/前端 | **阻塞** | 联调前 | 缺失则自助提权缺口未闭合；可先只上模板管理页（开关隔离） |
| `ErrorCode` / `httpStatusFor` / `errors` 同步 + 新测试文件加入 `npm test` 清单 | 后端/测试 | **阻塞** | 全量回归前 | 不同步会返回 500 或新用例不执行 |
| **测试夹具改造（复用种子行 id）+ `ui-audit.test.ts` 断言同步（B1/M1）** | 测试 | **阻塞** | 全量回归前 | **不改则 `npm test` 必然红**；禁用随机 `composition_id`（`getTemplate()` fail-closed） |
| 缩略图上传/读取接口 | 后端 | 并行 | 联调前 | 可降级：先只做元数据 + 启停，缩略图沿用 CSS 示意 |
| `TemplateDto` 字段扩展 + 3 个页面 `ttlMs` + 主动失效 | 前端 | 并行 | 联调前 | 缺失可保留旧字段 + 60s TTL 兜底 |
| 审计只读看板 / 复核待办红点 / 引用任务数 | 前端/数据 | 可绕过 | 上线后 | 先有表 + API，用 SQL 查询替代；引用任务数为 Should |
| 埋点 SDK / 推送通知 / 定时任务 / 密码二次验证 | 基础设施 | 可绕过 | V1.2 | r3 全部移出本期（S2/S3/D2） |
| Remotion 静帧生成缩略图 | 渲染链路 | 可绕过 | V1.2 | 运营手工上传静帧替代 |

### 11.2 上线顺序与灰度

夹具改造 → 迁移预发演练 → 角色脚本 bootstrap 2 名 admin + `requireAdmin` → 模板侧接口 + 审计 → 账号侧复核流程 + 四层防护 + 静态守卫 → 管理端两个页面（灰度：仅 `role=admin` 可见入口，开关 `PV_TEMPLATE_ADMIN`）→ 前台消费新字段与缩略图 → 全量 → 观察 1 个自然日。

**回滚**：前端开关关闭 + 保留 DB 新列；`GET /api/templates` 回退到 `DISPLAY` 兼容分支；账号页随开关下线，`users.role` 保留但不再有写入入口；迁移向下脚本仅在预发验证后才可在生产执行；角色依据审计精确还原。

### 11.3 上线后验证清单（Smoke）

1. 管理员登录 → `/api/me.role=admin`；普通用户管理端接口 403。
2. 管理端列表 4 行（含注册状态/启用数/引用计数为 Should）。
3. 改 `displayName` + `sortOrder` → 60s 内前台卡片与顺序更新（`templates/create/videos` 三处 TTL 一致），旧字段仍在。
4. 上传合法 PNG → 前台显示缩略图；上传 SVG → 400。
5. 停用第 1 套 → 前台减少 1 张；停用最后一套 → 409。
6. 停用模板的历史任务 `regenerate` → 明确拒绝、不扣额度；历史视频可播放/下载。
7. 同步动作 → 不覆盖已编辑元数据；未注册行标记 `registryMissing`。
8. 审计表覆盖全部写操作；`npm test` 全量通过、`npm run migrate:check` 通过。
9. 普通用户直输管理页 URL 被拦；撤销角色后不重新登录也立即 403。
10. 账号页成员列表只返回 4 个字段；角色变更记录与模板审计均可查。
11. 单人提权、改自己、伪造 claim、直接 `PATCH role=admin` 全部被拦且无角色变化。
12. A 申请 → A 自批被拒 → B 批准成功，C 成为 admin，审计恰好 1 条。
13. 撤销最后 1 名 admin 被拒；并发撤销后仍 ≥1 名；审计写失败时任一写操作整笔回滚。
14. `--list` 显示主/备 2 名 admin；admin 数降为 1 时页面提权冻结；脚本灾备补齐后恢复；两个新增测试文件已在 `npm test` 清单内执行。
15. **停用模板后 `retry` 仍可重试、`regenerate` 被拒**（TC-04a/04b）。
16. **注册缺失的启用行在同步时自动停用 + 写审计；此时停用最后一套可渲染模板被 409**（TC-21）。
17. **过期复核单在列表显示 `expired` 不可批准；并发批准只生效 1 次、审计 1 条**（TC-22/23）。
18. **合法 JWT 但 `users` 无行 → 401「账号未初始化」**（TC-02b）；确认生产 Auth 前提符合 Q7 结论。

---

## 12. 风险登记册

| 编号 | 风险 | 类别 | 概率 | 影响 | 等级 | 应对 | 责任人 |
|------|------|------|------|------|------|------|--------|
| RK-01（r3 改） | **测试夹具与种子行同值冲突**，加唯一约束后 `before` 钩子必失败 | 技术 | 5 | 4 | 20 高 | §6.2.1 方案 A 复用种子 UUID、删 INSERT/DELETE；检查 4 个文件 `after` 钩子禁误删种子；同步改 `ui-audit.test.ts`；禁用随机 id；预发全量回归为放行门槛 | 后端 + 测试 |
| RK-02 | 管理接口越权 / 伪造 role 提权 | 安全 | 3 | 5 | 15 高 | 服务端查库；统一 wrapper + 静态守卫；四层防护 + 双人复核；审计全覆盖 | 后端 |
| RK-12（r2） | 单个 admin 给小号提权 / 两名 admin 合谋 | 安全 | 4 | 5 | **20 高** | 规避：双人复核 + 禁改自己 + 无单步提权接口 + 条件更新；缓解：待复核红点 + 100% 留痕 + 月度名单核对；残余合谋接受 | 产品 + 后端 + 安全 |
| **RK-16（r3 新，B4）** | 生产走 Supabase JWT 但 `users` 无行，`requireAdmin` 全面 401、账号页不可用 | 技术/进度 | 4 | 4 | **16 高** | §11.1 阻塞依赖（Q7）；明确 401「账号未初始化」；TC-02b / 冒烟 18；若选「否」，先定义用户行同步 | 后端 + 运维 |
| **RK-17（r3 新，B3）** | 注册缺失行占用启用数，停用最后一套可渲染模板后全站无法创作 | 技术/体验 | 3 | 5 | **15 高** | 计数条件带注册命中；同步自动停用 + 审计；TC-21 / 冒烟 16；前台空态引导 | 产品 + 后端 |
| RK-03 | 停用最后一套模板导致全站无法创作 | 运营/体验 | 3 | 5 | 15 高 | 服务端「可渲染启用数 ≥1」条件更新；监控启用数 | 产品 + 后端 |
| RK-04（r3 补） | 元数据迁移遗漏 / 删除 `TEMPLATE_DISPLAY` 后 `ui-audit.test.ts` 断言失败 | 数据 | 4 | 3 | 12 中 | 一次性回填 + 逐字比对 + 静态断言；**同步修改 `ui-audit.test.ts` 断言**（M1） | 前端 + 测试 |
| RK-05 | 5min 缓存导致停用后前台仍可见 | 技术/体验 | 4 | 3 | 12 中 | **3 个页面** `ttlMs`→60s + 主动失效 + 提交链路服务端二次校验；不改 `DEFAULT_STALE_MS`（M2） | 前端 |
| RK-10 | 角色撤销到 0 名锁死后台 / 只剩 1 名导致提权冻结 | 运营/安全 | 3 | 4 | 12 中 | 页面/脚本双入口条件更新；初始化主备 2 名；`--list` 月度核对；脚本灾备 | 运维 + 测试 |
| RK-11 | 生产接 Supabase Auth 后用户主体变化，用户管理做两遍 | 需求/进度 | 4 | 3 | 12 中 | 本期按 A6 只做角色层；Auth 方案确定后另立需求；`users.role` 与主体解耦 | 产品 |
| RK-13（r2） | 成员列表扩大 PII 可见面 / 邮箱枚举 | 合规/数据 | 3 | 3 | 9 中 | 精确 email 匹配（Q6 默认）+ 10 次/分限流 + 结构化告警日志；最小 4 字段；审计只记 UUID；不导出 | 后端 + 产品 |
| RK-14（r2） | 复核流程卡死（唯一复核人离职、申请无人处理） | 运营 | 3 | 3 | 9 中 | 初始化 2 名 + 待复核红点 + 24h 过期可重发 + 脚本灾备 | 产品 + 运维 |
| RK-15（r2） | 新错误码未同步 / 新测试未加入 `npm test` 清单 | 技术 | 3 | 4 | 12 中 | 三处同步 + 静态守卫 + 冒烟 14；CI 增加清单覆盖断言 | 后端 + 测试 |
| RK-06 | 缩略图上传引入 SVG / 路径穿越 | 安全 | 2 | 5 | 10 中 | 复用 `upload.ts` 三重校验 + 受控读取 + nosniff/CSP | 后端 |
| RK-07 | 运营误改元数据且无版本回滚 | 运营 | 3 | 3 | 9 中 | 二次确认 + before/after 审计 + 依据审计恢复 | 产品 |
| RK-08 | 改元数据后历史任务「变脸」 | 数据 | 3 | 2 | 6 低 | 历史任务不回读模板元数据，只用 `input_json` 快照 | 后端 |
| RK-09 | Remotion 静帧商用授权范围 | 合规 | 2 | 4 | 8 中 | 沿用既有授权核对结论；本期运营上传静帧规避 | 产品 + 法务 |

---

## 13. 决策记录与待确认项

**本轮已决策（r2）**

| 编号 | 决策点 | 结论 |
|------|--------|------|
| Q2 | 管理员账号怎么管、自助提权防护要不要加 | 已拍板：账号页一起做，防护一起加；U2 脚本降级为 bootstrap/灾备，日常走 U4 页面 + 双人复核 |

### 13.1 r3 评审拍板项（暂按评审建议默认落地，待评审签字）

| 编号（对应评审） | 问题 | 评审建议 | **r3 采用的默认值** | 若改选的影响 | 落点 |
|---|---|---|---|---|---|
| **Q6（Q-C / D3）** | 成员列表 email 搜索方式 | 精确匹配，或前缀 ≥3 字符；补限流 | **方案 A 精确 email 匹配 + 10 次/分限流**（最保守） | 选前缀匹配需放宽枚举防护并补审计理由；选「默认只列 admin + 近 30 天活跃」需定义活跃口径 | FR-15、§7.2、§8.3 |
| **Q7（Q-A / B4）** | 本期生产是否以 `PV_AUTH_MODE=local` 为前提 | 是：写入阻塞依赖；否：先定义 Supabase 用户同步 | **是** | 选「否」须先实现 `auth.users → users` 同步（Webhook / 首次登录 upsert），否则账号页与 `requireAdmin` 全面不可用、排期后移 | §2.3 A8、§11.1、TC-02b、RK-16 |
| **Q8（Q-B / B2）** | `retry` 是否受模板停用影响 | 不受（方案 ①） | **不受**；`regenerate` 仍受 | 选「受」需在 `retryJob` 事务内加 enabled 校验，并额外定义额度返还与 `attempt` 计数口径，改动 `job-state.ts` 与队列测试 | FR-12、TC-04a/04b、§9.1、A9 |
| **Q9（Q-D / D4）** | 模板审计是否与角色审计统一为同事务 | 是 | **是**（失败整笔回滚、返回 500） | 选「否」需删除 §7.3 的事务表述并新增「告警但不阻断」的补偿机制，会引入审计缺失风险 | FR-09、§7.3、§8.2.3、§10、TC-20 |

**待确认（原 Q1/Q3/Q4/Q5，本轮未变更）**

| 编号 | 决策点 | 选项与影响 |
|------|--------|------------|
| Q1 | 是否需要「草稿 → 发布」两态？ | 本期按 A5 只做 `enabled` 直接生效；两态需新增 `status` 字段、预览流程与版本表，并改动 `jobs.ts` 条件 |
| Q3 | 分类是否允许运营自定义？ | 建议固定 4 类代码枚举；自定义需新增字典表 + CRUD + 前台筛选兼容 |
| Q4 | 提权双人复核是否按本期方案落地？ | 建议按 FR-17 落地。若退化为「单人提权 + 事后告警」，会留下可被单人利用的时间窗，需产品与安全共同签字接受 |
| Q5 | 复核单 24h 有效期是否合适？ | 建议 24h；缩短提高过期重发率，延长拉长未处理风险窗口；需运维确认值守节奏 |

---

## 附录 A：需求追踪矩阵（RTM）

| 需求来源 | 需求 | 本方案章节 | 验收 |
|----------|------|------------|------|
| PRD 第 4 章「模板列表」 | 管理端全量列表/筛选 | §5 FR-01/02、§7.2 | TC-08 |
| PRD 第 4 章「模板分类」 | 分类筛选与排序 | §5 FR-06、§6.3 | 冒烟 2 |
| PRD 第 4 章「模板启停」 | 启用/停用 + 守卫 | §5 FR-04/05、§9.1 | TC-01、TC-21、冒烟 5/16 |
| PRD 第 3 章「管理员：管理模板」 | 角色与鉴权 | §8.0、§8.1 | TC-02/02b/12、冒烟 1/9/18 |
| PRD 第 3 章「管理员：管理用户」（收窄解释） | 角色层账号管理 | §2.4、§5 FR-13/15、§8.2 | TC-11/13/14、冒烟 10 |
| PRD 5.4「模板统一规格 / 参数 JSON」 | 渲染契约留在代码层 | §4.1、§6.3 | TC-05 |
| 技术方案「禁止上传自定义 Remotion 代码」 | 禁止手填 compositionId / 代码上传 | §0、§4.1、§7.2 | 静态守卫用例 |
| 验收报告遗留「thumbnailPath 未消费」 | 缩略图上传与展示 | §5 FR-07 | TC-06、冒烟 4 |
| 本方案 G-07/G-08 | 审计 + 一致性守卫 + 夹具改造 | §5 FR-08/09、§6.2.1 | TC-05/08/20、冒烟 7/8 |
| 本方案 G-11 | 管理员账号生命周期与留痕 | §5 FR-13、§6.1/6.2、§8.2 | TC-10/11、冒烟 14 |
| 本方案 G-12 | 自助提权四层防护 + 双人复核 | §5 FR-16/17/18、§8.2.3/8.2.4、§9.2 | TC-12~20/22/23、冒烟 11~13/17 |
| **评审 B1（r3）** | 夹具与种子行冲突修复 | §1.2 G-08、§6.2.1、§11.1、RK-01 | 冒烟 8（`npm test` 全绿） |
| **评审 B2（r3）** | `retry` / `regenerate` 口径拆分 | §1.3 A9、§5 FR-12、§9.1 | TC-04a/04b、冒烟 15 |
| **评审 B3（r3）** | 启用数排除注册缺失 + 自动停用 | §1.2 G-13、§4.3、§5 FR-05/08、§6.1、RK-17 | TC-21、冒烟 16 |
| **评审 B4（r3）** | 生产 Auth 前提与账号未初始化 401 | §2.3 A8、§8.1、§11.1、RK-16、Q7 | TC-02b、冒烟 18 |
| **评审 D1/D2（r3）** | 并发批准保护 / 过期单列表过滤 | §5 FR-17、§8.1 伪代码、§8.2.4、§9.2 | TC-22/23、冒烟 17 |
| **评审 D4（r3）** | 审计统一同事务 | §5 FR-09、§7.3、§8.2.3、§10 | TC-20、冒烟 13 |
| **评审 S2（r3）** | 埋点 SDK 后置但保留最小复盘能力 | §2.2 Won't、§6.4 | 审计只读看板评审确认 |
| 本方案 RK-11 / C-04 | 业务用户后台不做、Auth 后另立需求 | §2.2 Won't、§2.3 A6、§8.2.6 | 范围评审确认 |

## 附录 B：合规声明

本方案为产品设计参考，具体实施请结合公司合规与法务要求确认。文档内所有示例数据、指标目标值均为产品建议或虚构示例，未引用任何第三方专有文档、文案或视觉资产；涉及个人信息处仅使用工单号/UUID 等标识，不含真实姓名、手机号或邮箱明文示例。管理端成员列表展示账号邮箱属于选择角色变更目标的业务必要信息，仅管理员可见；r3 起搜索默认精确匹配并限流 10 次/分，查询行为仅写结构化告警日志；审计记录、日志与看板只使用 UUID 与 requestId，不提供成员数据导出，不收集与模板/角色管理无关的个人信息。涉及 Remotion 商用授权的既有风险项沿用项目风险登记册，不因本方案扩大使用范围。

## 附录 C：r3 评审反馈决策表

> 评审结论「有条件通过」，共 17 条反馈。按「阻塞 4 / 设计缺陷 5 / 基线校正 5 / 范围建议 3」分组收敛；逐条判定 **采纳 / 部分采纳 / 确认**，全部给出理由与修订落点。**评审意见原文未改动。**

### C.1 阻塞项（4 条，全部采纳）

| # | 评审意见 | 判定 | 理由 | r3 修订落点 |
|---|----------|------|------|-------------|
| B1 | 夹具冲突描述不准，且「改随机 id」有隐含障碍 | **采纳** | 核对 4 个夹具与 `003_seed_templates.sql` 同值；`createVideoJob` 要求注册表命中，随机 id 会让提交类测试失败 | §1.2 G-08、§1.3、§6.2 步骤 6、新增 §6.2.1（推荐复用种子 UUID）、§6.2 回滚段、§11.1、RK-01 |
| B2 | `retry` 不受停用影响，文档误写「一律拒绝」 | **采纳（方案 ①）** | `src/lib/job-state.ts` 的 `retryJob` 确实不回查模板；retry 是已付费失败任务补偿，方案 ② 需额外定义额度返还与 attempt，成本更高 | §1.1/§1.2 G-09/§1.3、§2.3 A9、FR-12、TC-04a/04b、§9.1、冒烟 15、Q8 |
| B3 | 启用数守卫未排除 `registryMissing` | **采纳** | 计数只数 DB 行会让注册缺失行占用名额，管理员可停用最后一套可渲染模板导致全站无法创作 | §0 硬约束 3、§1.2 G-13、§4.3、FR-05/08、§6.1/6.3、§9.1、TC-21、冒烟 16、RK-17、附录 A |
| B4 | 生产 Supabase JWT 下 `users` 行来源未定义 | **采纳** | `001_init.sql` 无自动建行机制；JWT 只验签返回 sub；`/api/me` 查不到行即 401，`requireAdmin` 会全面 401 | §1.3、§2.3 A8、FR-10、TC-02b、§8.1 伪代码、§11.1 阻塞依赖、冒烟 18、RK-16、Q7 |

### C.2 设计缺陷（5 条）

| # | 评审意见 | 判定 | 理由 | r3 修订落点 |
|---|----------|------|------|-------------|
| D1 | 批准事务缺 target 行并发保护 | **采纳** | `assert` 与 `update` 间无锁，驳回后重申请 + 并发批准可能双写 | §8.1 伪代码改条件更新 `count===1`、FR-17、§7.3、TC-22、冒烟 17 |
| D2 | 24h 过期依赖惰性置位，列表显示可批准过期单 | **采纳** | 项目无定时任务基础设施；列表不过滤会让审批人误判 | FR-17、§6.1、§7.2、§8.2.4、§9.2、§10、TC-23、冒烟 17、Won't 增「定时任务」 |
| D3 | email 模糊搜索是枚举攻击面 | **部分采纳** | 精确匹配、限流、Q6 均采纳；但评审建议「写入 `admin_forbidden` 同类埋点」与 S2「本期不建埋点基础设施」冲突，改为**结构化告警日志**（复用现有日志与 `rate-limit.ts`），不新建埋点 SDK | FR-15、§2.2 Won't、§7.2、§8.3、§13.1 Q6、RK-13 |
| D4 | 审计「写失败不阻断」与「同事务」自相矛盾 | **采纳** | 同事务必然回滚；模板仅 4 行无高并发顾虑，统一后少一个分支 | FR-09、§6.1、§7.3、§8.2.3 差异段落删除并改写、§10、TC-20、冒烟 13、Q9 |
| D5 | `ETag` 没有消费者 | **采纳（删除）** | 核对 `src/lib/client/api.ts` 无 `If-None-Match`/304 处理，前端用模块级缓存；加了无收益 | §1.3、FR-11、§7.1、§2.2 Won't |

### C.3 基线小错（5 条）

| # | 判定 | 处理 |
|---|------|------|
| M1 | **采纳** | §4.2、§6.2 步骤 6、§11.1、RK-04 补「同步修改 `tests/ui-audit.test.ts` 的 `displayFor`/`englishName`/`cta` 断言」 |
| M2 | **采纳并扩展** | §1.1、FR-11、§7.1、RK-05 明确 `ttlMs` 落点为 **`templates/create/videos` 3 个页面**（比评审多 2 处），不改 `DEFAULT_STALE_MS`；主动失效同一 `cacheKey` |
| M3 | **采纳** | §7.3 删除 `TEMPLATE_IN_USE`（无删除接口即无触发路径） |
| M4 | **确认，不修改** | `/api/me` 返回 `id/email/quotaLeft/createdAt` 与 FR-15 成员列表字段一致，§1.1 描述无误；仅记录核对结论 |
| M5 | **采纳** | TC-02 改为「普通用户 + 伪造 JWT `role=admin` claim」，注明 `X-Dev-User-Id` 仅非生产生效、生产 fail-closed；§1.1/§8.1 补注 |

### C.4 范围建议（3 条）

| # | 判定 | 理由与落点 |
|---|------|-----------|
| S1 | **采纳** | FR-02 关联任务数降为 Should，§2.2 Should 增列，§7.2 说明调整，避免每行 `COUNT(*)` |
| S2 | **部分采纳** | 同意本期不建埋点 SDK（§2.2 Won't、§6.4 重写为「本期最小数据能力 + V1.2 事件清单」、§11.1 移出阻塞依赖）；但按「每版本至少 1 个核心指标看板」的口径，**保留审计表只读看板**作为最小复盘能力，不能上线无数据可复盘；埋点事件清单保留为 V1.2 建议而非删除 |
| S3 | **采纳** | FR-17、§8.2.2/8.2.4/8.2.5、RK-12 中「通知全体 admin」改为「待复核 Tab + 顶部红点」，不做推送；§2.2 Won't 增「消息推送」 |

### C.5 收敛结果

| 判定 | 条数 | 编号 |
|------|------|------|
| 采纳 | 14 | B1~B4、D1、D2、D4、D5、M1、M2、M3、M5、S1、S3 |
| 部分采纳 | 2 | D3（埋点改结构化日志）、S2（保留审计看板） |
| 确认不修改 | 1 | M4 |

> 4 个拍板项集中在 §13.1（Q6~Q9），r3 暂按评审建议默认落地；若评审签字选择不同，按决策表增量修订对应章节，不重写全文。
