# ProductVideo AI 技术架构与实施方案

本文档是 ProductVideo AI 的技术架构与实施方案终版。技术方向与选型为——模块化单体、Next.js 全栈、Supabase PostgreSQL、Remotion + FFmpeg 渲染、Node.js Worker 异步任务、VPS 本地磁盘存储。文档覆盖三个层面：**技术细节**（可直接编码的接口、DDL、协议、配置）、**落地性**（部署、运维、监控、备份、测试）、**可扩展性**（抽象层、扩展点、触发阈值与演进路径）。文中所有版本、阈值与容量数字均为建议值，需以实际压测与许可证核对结果为准。

| 项目 | 内容 |
|------|------|
| 文档名称 | ProductVideo AI 技术架构与实施方案 |
| 版本 | V1.0 |
| 编写角色 | 高级开发工程师 |
| 编写日期 | 2026-11-25 |
| 上游依据 | 产品需求文档 PRD V1.0、用户故事与产品设计说明 |
| 适用范围 | 后端开发、前端开发、渲染开发、部署运维 |
| 状态 | 供评审 |

## 1. 设计目标、边界与技术原则

本节固化设计的目标与非目标，明确不可动摇的架构原则，作为后续所有技术决策的裁决依据。

### 1.1 技术目标

| 目标 | 可衡量标准 |
|------|------------|
| 端到端闭环 | 图片上传 → 选模板 → 生成文案 → 渲染 MP4 → 下载，全链路打通 |
| 渲染不阻塞请求 | 提交接口 P95 < 500ms，渲染在独立进程异步执行 |
| 任务可靠 | 同一任务仅一个 Worker 执行；失败可重试；失败返还额度；任务不永久卡在 processing |
| 数据隔离 | 用户只能读写自己的商品、任务与文件；下载走鉴权接口 |
| 单台可部署 | 一台 2vCPU/4GB VPS 可跑通 Web + Worker + Remotion + Nginx |
| 可演进 | 队列、存储、渲染的扩展不推翻业务代码，只替换实现层 |

### 1.2 非目标（本期不做）

| 非目标 | 原因 |
|--------|------|
| 分布式渲染 / 多机队列 | 早期规模不需要，引入即增加复杂度 |
| 对象存储（S3/R2） | 本地磁盘足够，先用抽象层隔离，按容量阈值再切 |
| 通用视频编辑器 / 时间轴 | 产品定位是模板化生成，不是编辑器 |
| 用户上传自定义 Remotion 代码 | 安全红线，禁止任意代码执行 |
| 多租户与复杂角色体系 | V1.0 仅三类角色，数据归属校验即可 |

### 1.3 架构原则（不可动摇）

| 原则 | 落地约束 |
|------|----------|
| 简单优先 | 不引入 Redis、BullMQ、S3/R2、Lambda、K8s、微服务 |
| 模块化单体 | 单代码仓库、单进程组，模块边界清晰，靠接口解耦 |
| AI 参数化 | AI 只产出符合 JSON Schema 的参数，**绝不生成 React 代码** |
| 异步渲染 | Web 进程与 Worker 进程物理分离，通过数据库队列通信 |
| 本地存储 | 文件统一走 FileStorage 抽象，当前实现 LocalFileStorage |
| 渐进扩展 | 每个可替换点定义清晰接口与触发阈值，压力到来再切换实现 |

## 2. 系统架构

本章给出六层架构总览，并补充进程视图、运行视图与数据流，明确 Web 进程与 Worker 进程的边界。

### 2.1 分层架构

| 层次 | 组件 | 职责 |
|------|------|----------|
| 用户访问层 | 浏览器 | 页面交互、Remotion Player 预览、鉴权下载 |
| Next.js 应用层 | Pages + Route Handlers | 页面渲染、业务 API、会话校验、参数校验 |
| 业务数据层 | Supabase PostgreSQL | 业务实体、任务队列、用量记录、行锁 |
| AI 服务层 | OpenAI / Claude | 商品文案与卖点生成，输出受 Schema 约束 |
| 视频处理层 | Node.js Worker + Remotion + FFmpeg | 领取任务、组装参数、渲染编码、缩略图 |
| 本地文件存储层 | VPS 持久化磁盘 | 上传件、临时渲染目录、成片、缩略图 |

### 2.2 进程与部署视图

Web 与 Worker 是同一代码仓库的**两个独立运行进程**，可部署在同一台 VPS，但生命周期、日志和扩缩容相互独立。

```text
                        ┌──────────────────────────────────────┐
   浏览器 ──HTTPS──▶ Nginx ──▶ Next.js Web (PM2/systemd, :3000) │
                        │         │ 业务 API / 页面 / 鉴权下载    │
                        │         └──▶ Supabase PostgreSQL (托管) │
                        │                    ▲ 任务表 (行锁队列)    │
                        │         ┌──────────┘                   │
                        │         ▼                              │
                        │  Node.js Worker (PM2/systemd)           │
                        │    └─▶ Remotion Renderer ─▶ FFmpeg       │
                        │         └─▶ 本地磁盘 /opt/product-video/data
                        └──────────────────────────────────────┘
```

关键约束：

- Web 进程只负责 HTTP 请求与轻量同步逻辑，禁止在请求内执行渲染。
- Worker 进程不监听公网端口，只轮询数据库任务表。
- 两进程共享的仅为：数据库、本地磁盘路径约定、代码库中的类型与 Schema 定义。
- 用 PM2 的 ecosystem 配置或 systemd unit 分别管理，崩溃自动拉起。

### 2.3 核心数据流（提交到下载）

```text
1. 用户在创作页提交 → POST /api/videos (Idempotency-Key)
2. API: 校验 Schema → 校验额度 → [事务] 创建 video_jobs(pending) + 扣减额度 + 写 usage_record
3. API 立即返回 { jobId, status: pending }
4. Worker: SELECT ... FOR UPDATE SKIP LOCKED 领取 → status=processing（写心跳）
5. Worker: 组装 input.json → Remotion 渲染 → FFmpeg 编码 → 生成缩略图
6. Worker: 移动到正式目录 → [事务] status=completed + output_path + completed_at
7. 前端轮询 GET /api/videos/:id 拿到 completed → GET /api/videos/:id/download（鉴权）
8. 失败路径：error_message 落库 → status=failed → [事务] 返还额度 → 用户可重试
```

## 3. 技术选型与版本固化

给出建议版本与职责边界，标注商用前必须核对的许可证风险。版本以项目 lockfile 为准，表中为选型基线。

| 模块 | 选型 | 建议版本基线 | 职责 | 备注 |
|------|------|--------------|------|------|
| 运行时 | Node.js | 20 LTS | Web 与 Worker 运行时 | 选 LTS，避免语法/依赖兼容问题 |
| 语言 | TypeScript | 5.x | 全栈强类型 | 共享类型与 Schema 是参数化核心 |
| 前端框架 | Next.js (App Router) | 14/15 | 页面 + Route Handlers | 用 App Router 与普通 Node runtime |
| UI | Tailwind CSS + shadcn/ui | Tailwind 3.x | 组件与样式 | 不锁死大版本，按生态更新 |
| 数据库 | PostgreSQL (Supabase) | 15+ | 业务数据与队列 | 用 `SKIP LOCKED`、JSONB、事务 |
| 认证 | Supabase Auth | — | 邮箱密码登录、会话 | 复用其 JWT 与 RLS |
| 数据访问 | Prisma 或 Supabase 客户端 | Prisma 5.x | ORM | 二选一，禁止双 ORM 混用 |
| 参数校验 | Zod | 3.x | 文案与渲染参数校验 | 与 AI 输出 Schema 共用定义 |
| 视频渲染 | Remotion | 4.x | 模板与渲染 | **source-available，商用前核对授权** |
| 视频编码 | FFmpeg | 系统包 | 转码/截帧/压缩 | 随系统安装，注意编解码器授权 |
| 任务队列 | PostgreSQL 表 | — | 轻量队列 | 不引入 Redis/BullMQ |
| 文件存储 | Local File Storage | — | 图片/视频/缩略图 | 统一接口封装 |
| 进程管理 | PM2 或 systemd | — | 守护与自启 | 二选一 |
| 反向代理 | Nginx | 稳定版 | HTTPS、静态、限流 | 证书用 Let's Encrypt |

许可证风险提示：Remotion 对不同营收规模的组织有授权要求，正式商用前必须按其最新许可条款核对资格与费用，并在预算中计入；FFmpeg 的编解码器（如 H.264）授权视分发方式而定，需合规确认。此项属于上线阻塞检查项。

## 4. 数据库详细设计

本章给出 6 张业务表的完整 DDL、约束、索引与迁移策略。SQL 中的金额为可选扩展字段，本期可暂不启用订阅相关表。

### 4.1 完整表结构（DDL）

```sql
-- 用户：主键直接复用 Supabase Auth 的 user UUID
CREATE TABLE users (
  id          UUID PRIMARY KEY,                  -- 与 auth.users.id 一致
  email       VARCHAR(255) NOT NULL UNIQUE,
  quota_left  INTEGER NOT NULL DEFAULT 3,        -- 剩余免费额度
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 商品
CREATE TABLE products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  description    TEXT,
  price          NUMERIC(12,2),
  image_path     TEXT NOT NULL,                   -- 相对路径，见第 9 章
  selling_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  brand_name     VARCHAR(120),
  brand_logo_path TEXT,
  brand_color    VARCHAR(16),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_user ON products(user_id, created_at DESC);

-- 视频模板
CREATE TABLE video_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  category      VARCHAR(60) NOT NULL,             -- launch/highlight/sale/showcase
  composition_id VARCHAR(80) NOT NULL,            -- Remotion Composition ID
  duration_sec  SMALLINT NOT NULL DEFAULT 15,
  thumbnail_path TEXT,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_templates_enabled ON video_templates(enabled, category);

-- 视频任务（队列核心表）
CREATE TABLE video_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  template_id   UUID NOT NULL REFERENCES video_templates(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  input_json    JSONB NOT NULL,                   -- 已校验的渲染参数快照
  output_path   TEXT,
  thumbnail_path TEXT,
  error_message TEXT,
  attempt       SMALLINT NOT NULL DEFAULT 0,      -- 已尝试次数
  idempotency_key VARCHAR(128) NOT NULL,          -- 提交幂等键
  leased_at     TIMESTAMPTZ,                      -- Worker 领取心跳
  lease_until   TIMESTAMPTZ,                      -- 租约到期，用于超时回收
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_jobs_claim ON video_jobs(status, created_at)
  WHERE status = 'pending';                       -- 领取队列的部分索引
CREATE INDEX idx_jobs_user ON video_jobs(user_id, created_at DESC);
CREATE UNIQUE INDEX uq_jobs_idem ON video_jobs(user_id, idempotency_key);

-- 订阅（V1.0 后置，先建表占位）
CREATE TABLE subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan        VARCHAR(20) NOT NULL CHECK (plan IN ('starter','pro','agency')),
  status      VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 用量记录：扣减与返还都记账，便于对账
CREATE TABLE usage_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_job_id UUID REFERENCES video_jobs(id),
  usage_type   VARCHAR(20) NOT NULL CHECK (usage_type IN ('consume','refund','grant')),
  amount       INTEGER NOT NULL,                  -- 扣减为正/返还为负，口径全系统统一
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_user ON usage_records(user_id, created_at DESC);
```

### 4.2 关键机制

- **updated_at 自动更新**：给 products 建触发器 `BEFORE UPDATE SET updated_at = now()`，避免应用层遗漏。
- **额度原子扣减**：在单个事务内 `UPDATE users SET quota_left = quota_left - 1 WHERE id = $1 AND quota_left >= 1 RETURNING quota_left`；影响行数为 0 即额度不足，整单回滚，杜绝并发超额。
- **幂等**：`uq_jobs_idem(user_id, idempotency_key)` 唯一索引，重复提交由数据库兜底，返回既有 jobId。
- **一致性**：成片落盘与 status=completed 在同一逻辑流程中，先落盘再改状态；数据库记录与文件的一致性由第 9 章的校验脚本兜底。

### 4.3 迁移与版本管理

- 用 Prisma Migrate 或独立 SQL 迁移脚本，所有 DDL 进版本库，禁止手工改生产库。
- 迁移遵循"先加后删"的兼容原则：新增列可空 → 回填 → 加约束 → 清理旧列。
- 每次迁移前备份数据库；迁移脚本需可在本地与生产重复执行（幂等）。

## 5. API 接口设计

统一 RESTful 契约，明确鉴权、幂等与错误码，供前后端并行开发。

### 5.1 接口清单

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | /api/auth/register | 否 | 邮箱注册 |
| POST | /api/auth/login | 否 | 登录，返回会话 |
| POST | /api/auth/logout | 是 | 退出 |
| GET | /api/me | 是 | 当前用户信息与剩余额度 |
| GET | /api/products | 是 | 商品列表（分页） |
| POST | /api/products | 是 | 新增商品 |
| GET | /api/products/:id | 是 | 商品详情 |
| PATCH | /api/products/:id | 是 | 编辑商品 |
| DELETE | /api/products/:id | 是 | 删除商品 |
| POST | /api/uploads/products | 是 | 上传商品图片（multipart） |
| GET | /api/templates | 是 | 已启用模板列表 |
| POST | /api/ai/copy | 是 | 生成营销文案 |
| POST | /api/videos | 是 | 提交生成任务（需 Idempotency-Key） |
| GET | /api/videos | 是 | 任务/视频列表（分页、按状态筛选） |
| GET | /api/videos/:id | 是 | 任务详情与状态（前端轮询） |
| POST | /api/videos/:id/retry | 是 | 失败/完成任务重新生成 |
| DELETE | /api/videos/:id | 是 | 删除视频与文件 |
| GET | /api/videos/:id/download | 是 | 鉴权下载成片 |
| GET | /api/admin/jobs | 管理员 | 任务监控 |
| GET | /api/admin/usage | 管理员 | 用量统计 |

### 5.2 统一约定

```typescript
// 统一响应包络
type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; fields?: Record<string,string> } };

// 提交生成任务请求
interface CreateVideoRequest {
  productId: string;
  templateId: string;
  copy: { title: string; subtitle: string; sellingPoints: string[]; cta: string };
  options?: { brandColor?: string; logoPath?: string; music?: string };
}
// 服务端响应：{ jobId: string; status: 'pending' }
```

- 鉴权：所有业务接口校验 Supabase JWT；资源查询一律带 `user_id` 过滤，禁止先全表查再应用层过滤。
- 幂等：`POST /api/videos` 强制 `Idempotency-Key` 请求头；重复键返回原任务，不重复扣额度。
- 错误码：`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、`VALIDATION_ERROR`、`QUOTA_EXHAUSTED`、`AI_UNAVAILABLE`、`RENDER_FAILED`、`RATE_LIMITED`；`VALIDATION_ERROR` 用 `fields` 返回字段级错误。
- 限流：按用户维度对 AI 与提交接口限流（建议 AI 10 次/分钟、提交 20 次/分钟），Nginx 层再做全局限流兜底。

## 6. AI 文案模块设计

AI 输出是渲染参数的唯一来源，必须受 Schema 强约束并可降级，这是参数化原则的核心落点。

### 6.1 输入输出契约

```typescript
// AI 输出必须严格符合此 Schema，Zod 校验失败即重试，不进入渲染
const CopySchema = z.object({
  videoTitle: z.string().min(1).max(60),
  subtitle: z.string().min(1).max(80),
  sellingPoints: z.array(z.string().min(1).max(40)).min(1).max(5),
  cta: z.string().min(1).max(20),
});
type Copy = z.infer<typeof CopySchema>;
```

- Prompt 模板：系统提示词中固化"仅输出 JSON、不得编造功效/认证/未经证实的声明、字段长度上限"，并要求模型按 Schema 输出。
- 结构化输出：优先使用供应商的 JSON mode / structured output；拿到文本后仍用 Zod 二次校验。
- 长度兜底：超长时按模板上限截断并提示，不允许把超长文本送进渲染导致版式溢出。

### 6.2 可靠性与成本

| 机制 | 设计 |
|------|------|
| 重试 | 校验失败或网络错误重试 ≤2 次，指数退避（1s/2s）；仍失败返回 `AI_UNAVAILABLE`，不扣额度 |
| 降级 | 主模型不可用时切备用模型；均不可用时允许用户手工填写文案继续创作 |
| 缓存 | 相同商品内容哈希 + 模板的文案结果可缓存（建议 TTL 24h），降低重复调用成本 |
| 密钥 | API Key 只存服务端环境变量，禁止下发前端；按环境隔离，定期轮换 |
| 成本监控 | 记录每次调用的 token 与费用，按用户维度汇总，异常增长告警 |

## 7. 视频渲染模块

Remotion 是核心技术资产。本节定义 Composition 参数契约、渲染流程和资源治理，确保模板可复用、渲染可观测。

### 7.1 Composition 参数契约

```typescript
// 所有模板共用统一 Props 契约，模板内部决定视觉与动画
interface ProductVideoProps {
  title: string;
  subtitle: string;
  imageUrl: string;        // 本地渲染用绝对文件路径或 data URL
  price?: string;
  sellingPoints: string[];
  cta: string;
  brandColor: string;
  logoPath?: string;
  musicPath?: string;
}
// 模板注册表：compositionId → React Component + 时长 + 默认配置
```

- 每个模板一个 Composition ID（`product-launch` / `product-highlight` / `product-sale` / `product-showcase`），与 `video_templates.composition_id` 对应。
- 动画、排版、字体、转场均由开发者在模板内控制，AI 只填参数。
- 预览与渲染共用同一套组件：预览用低分辨率（如 480×854）快速播放，正式渲染 1080×1920 / 30fps / H.264 MP4。

### 7.2 渲染流程与资源治理

```text
接收 input.json → 校验 → 解析素材绝对路径 → 选择 Composition
  → Remotion 渲染到临时目录 renders/{jobId}/temp.mp4
  → FFmpeg 截帧生成缩略图 thumbnails/{userId}/{jobId}.jpg
  → 原子移动到正式目录 videos/{userId}/{jobId}.mp4
  → 清理 renders/{jobId}/ → 回写数据库状态
```

| 治理项 | 设计 |
|--------|------|
| 并发控制 | MVP 单任务并发（Worker 内串行）；按 CPU/内存压测结果再调并发数 |
| 超时 | 单任务渲染超时建议 10 分钟，超时按失败处理并回收租约 |
| 内存 | 限制 Remotion/Chrome 进程内存，防止渲染把 VPS 打爆 |
| 字体 | 中文字体随镜像安装，避免渲染时缺字；字体文件纳入版本或镜像 |
| 失败隔离 | 单个任务失败不影响 Worker 主循环，捕获异常后继续领取下一个任务 |

## 8. 异步任务队列

用 PostgreSQL 表实现轻量队列，补齐领取协议、租约、超时回收与重试，防止任务重复执行或永久卡死。

### 8.1 领取协议（SKIP LOCKED）

```sql
-- Worker 每次领取一批（建议批量 1）：原子锁定并标记处理中
WITH claimed AS (
  SELECT id FROM video_jobs
  WHERE status = 'pending'
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE video_jobs j
SET status = 'processing',
    leased_at = now(),
    lease_until = now() + interval '2 minutes',
    attempt = attempt + 1
FROM claimed c
WHERE j.id = c.id
RETURNING j.*;
```

- `SKIP LOCKED` 保证多个 Worker 不会重复领取同一任务；本期虽只有 1 个 Worker，但协议天然支持多 Worker 扩展。
- 租约机制：Worker 处理中需定期续租（心跳），`lease_until` 过期视为宕机，任务可被回收。

### 8.2 超时回收与重试

| 场景 | 处理 |
|------|------|
| Worker 崩溃，任务卡在 processing | 定时扫描 `status='processing' AND lease_until < now()` → 重置为 pending（或按 attempt 判定 failed） |
| 渲染失败 | 写 error_message → status=failed → 事务内返还额度；attempt < 上限时允许自动重试一次 |
| 重试次数 | 建议总尝试上限 3 次，超过转 failed 并停止自动重试 |
| 取消 | 仅 pending/processing 可取消；取消需与 Worker 协作（租约检查），终态返还不重复 |
| 死信处理 | 多次失败任务进入人工排查列表，管理后台可见 error_message |

### 8.3 事务边界

- 创建任务 + 扣额度 + 写用量记录：同一事务，任一失败全部回滚。
- 状态更新（completed/failed）与额度返还：同一事务，保证状态与账目一致。
- 文件落盘在事务外完成，事务内只写路径；落盘失败按 failed 处理，不产生"完成但无文件"的脏状态。

## 9. 文件存储

文件全部存 VPS 本地磁盘，通过统一抽象封装，按安全规范处理访问与清理。

### 9.1 目录规范

```text
/opt/product-video/data/
├── uploads/{userId}/{productId}/<原图>.jpg       # 上传件
├── renders/{jobId}/input.json, temp.mp4          # 临时渲染目录（可清理）
├── videos/{userId}/{jobId}.mp4                   # 正式成片
└── thumbnails/{userId}/{jobId}.jpg               # 缩略图
```

### 9.2 存储抽象接口

```typescript
interface FileStorage {
  save(file: Buffer, relativePath: string): Promise<string>;
  read(relativePath: string): Promise<Buffer>;
  delete(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  getSignedPath(relativePath: string): string;   // 仅供鉴权接口内部使用
}
// 本期实现 LocalFileStorage；未来可加 S3FileStorage，业务代码不变
```

### 9.3 安全与治理

| 项 | 设计 |
|----|------|
| 上传校验 | 白名单扩展名 + MIME + 文件头 sniff；单文件 ≤10MB；重命名避免原文件名注入 |
| 路径穿越 | 所有路径由服务端按 userId/jobId 拼接，禁止直接使用用户输入作为路径；拒绝 `..` 与绝对路径 |
| 鉴权下载 | `/api/videos/:id/download` 校验 JWT + 资源归属后再读文件，禁止把 data 目录映射为公开静态目录 |
| 清理策略 | 渲染临时目录定期清理；删除视频同时删文件与记录；设置成片留存期限（建议 30 天） |
| 容量治理 | 磁盘使用率监控，超阈值告警并暂停提交；定期归档或删除过期成片 |
| 一致性核对 | 定时脚本比对数据库 output_path 与磁盘文件，修复孤儿文件与缺失文件 |

## 10. 认证、权限与数据隔离

沿用 Supabase Auth，配合 PostgreSQL RLS 与应用层双重校验，防止越权访问。

| 层 | 措施 |
|----|------|
| 认证 | Supabase Auth 邮箱密码；JWT 由服务端校验，前端仅持有会话 |
| 数据库 | 对 products / video_jobs / usage_records 启用 RLS，策略按 `auth.uid() = user_id` 限制 |
| 应用层 | 所有查询显式带 user_id 过滤；下载接口二次校验归属 |
| 角色 | 管理员通过白名单 user_id 或独立 claim 判定，仅 Admin API 使用 |
| 会话 | 退出清除会话；设置合理过期与刷新策略 |

说明：RLS 与应用层过滤同时启用，前者是兜底防线，后者是可读性与可控性保障；两者都做，不互相替代。

## 11. 可观测性与运维

早期也要具备"看得见问题"的能力，否则任务卡死或渲染失败无法及时发现。

| 能力 | 落地设计 |
|------|----------|
| 结构化日志 | Web 与 Worker 输出 JSON 日志，含 jobId、userId、耗时、状态；按天切分 |
| 任务指标 | 提交数、成功率、平均渲染时长、失败原因分布、队列积压量 |
| 告警 | 队列积压超阈值、失败率超阈值、磁盘超阈值、Worker 心跳丢失 → 通知（邮件/Webhook） |
| 健康检查 | `/api/health` 返回 DB 连通性与磁盘余量；Worker 心跳写数据库 |
| 链路追踪 | 以 jobId 作为贯穿 ID，串联提交、领取、渲染、下载各阶段日志 |
| 运营看板 | 管理后台展示任务监控与用量统计（对应 US-21 / US-22） |

## 12. 部署与运维落地

给出从零部署到日常运维的可执行步骤与配置样例。

### 12.1 环境准备

```bash
# 系统：Ubuntu LTS；创建部署用户与目录
sudo apt update && sudo apt install -y nginx ffmpeg fonts-noto-cjk
mkdir -p /opt/product-video/data/{uploads,renders,videos,thumbnails}
# Node 20 LTS（用 nvm 或 NodeSource 安装）
# 环境变量写入 .env.production，禁止入库
```

关键环境变量（示例，值以实际为准）：

```text
DATABASE_URL=postgresql://...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...   # 仅服务端
AI_API_KEY=...                  # 仅服务端
DATA_DIR=/opt/product-video/data
RENDER_TIMEOUT_MS=600000
MAX_CONCURRENT_RENDER=1
```

### 12.2 进程守护（PM2 示例）

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    { name: 'pv-web', script: 'node_modules/next/dist/bin/next', args: 'start', env: { NODE_ENV: 'production' } },
    { name: 'pv-worker', script: 'dist/worker/index.js', instances: 1, env: { NODE_ENV: 'production' } },
  ],
};
// pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

### 12.3 Nginx 关键配置

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.example;
    client_max_body_size 11m;                 # 略大于 10MB 上传限制
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
    # 注意：不暴露 /data 静态目录，下载必须走鉴权 API
}
```

### 12.4 备份与恢复

| 对象 | 策略 |
|------|------|
| 数据库 | 每日自动备份（pg_dump / Supabase 备份），保留 7～30 天，异地存储 |
| 文件 | 成片与上传件定期同步到备份存储；按留存策略清理 |
| 演练 | 每季度做一次恢复演练，验证备份可用 |
| 变更前 | 部署与迁移前先备份，保留回滚点 |

### 12.5 发布与回滚

- 采用"构建 → 灰度开关 → 全量"的节奏；本产品早期用户少，可用开关控制新功能可见性。
- 每次发布记录版本号与变更摘要；回滚按上一次构建产物 + 数据库迁移回滚脚本执行。
- 发布后跑冒烟：注册登录 → 上传 → 生成 → 渲染 → 下载 → 额度变化核对。

## 13. 可扩展设计

扩展不推翻业务代码，只在抽象层替换实现。明确每个扩展点、触发阈值与演进路径。

### 13.1 扩展点与触发阈值

| 扩展点 | 当前实现 | 触发阈值（建议） | 演进路径 |
|--------|----------|------------------|----------|
| 任务队列 | PostgreSQL 行锁 | 队列积压持续 > 100 或领取延迟 > 30s | 引入 Redis + BullMQ，Worker 逻辑不变（只换领取协议） |
| 文件存储 | 本地磁盘 | 磁盘 > 70% 或需多机访问 | 实现 S3FileStorage，业务只用 FileStorage 接口 |
| 渲染能力 | 单机单任务 | 渲染排队 > 10 分钟 | 多 Worker 并行；再演进到独立渲染机/容器池 |
| 模板数量 | 4 套硬编码 | 模板 > 10 套 | 模板注册表 + 配置化，模板独立版本管理 |
| 用户规模 | 单库单租户 | 并发用户 > 数百 | 读写分离、连接池；多租户时引入 tenant_id 与隔离策略 |
| 商业化 | 后置订阅 | 试用客户验证付费意愿 | 接入 Stripe，启用 subscriptions 表与去水印/额度提升 |
| 开放能力 | 无 | 代运营/SaaS 客户提出集成需求 | 开放 API 生成（API Key + 配额 + 计量计费） |

### 13.2 演进路径（本期 → 后续）

```text
V1.0  单 VPS 闭环：Web + Worker + Remotion + 本地磁盘 + PG 队列
V1.1  批量生成 + 品牌配置：复用参数化管线，增加批量任务编排
V1.2  存储抽象切换：按容量阈值引入对象存储，业务代码零改动
V1.3  队列与渲染扩展：Redis/BullMQ + 多 Worker，提升吞吐
V2.0  开放平台：API Key、计量计费、多租户隔离
```

### 13.3 保持可扩展的编码约束

- 所有外部依赖（AI、存储、队列、渲染）通过接口注入，业务层不直接调用具体实现。
- 参数 Schema 与类型集中在 shared 层，前后端与 Worker 共享，避免口径漂移。
- 数据库迁移、配置项、模板注册全部版本化，杜绝"改一台机器的隐藏状态"。

## 14. 安全设计

| 风险 | 防护 |
|------|------|
| 越权访问 | JWT 校验 + RLS + 应用层 user_id 过滤 + 下载归属校验 |
| 上传攻击 | 类型/大小/文件头校验、重命名、隔离目录、禁止执行权限 |
| 路径穿越 | 服务端拼接路径、拒绝 `..` 与绝对路径、realpath 校验落点 |
| XSS | 前端输出转义，文案参数进入渲染前做净化 |
| 任意代码执行 | 禁止用户上传/执行 Remotion 代码，Composition 固定由开发者维护 |
| 密钥泄露 | 密钥仅存服务端环境变量，不进版本库、不下发前端 |
| 限流防刷 | Nginx 全局限流 + 应用层按用户限流（AI/提交接口） |
| 依赖风险 | 定期更新依赖，关注安全公告，锁定 lockfile |

## 15. 测试策略

| 层级 | 覆盖内容 | 关键用例 |
|------|----------|----------|
| 单元测试 | Schema 校验、额度计算、状态机迁移、路径拼接 | 超长文案被拒、额度为 0 不扣减、非法状态迁移被拦 |
| 集成测试 | API + 数据库事务、AI Mock、文件读写 | 重复幂等键只建一个任务；失败任务额度返还 |
| 队列测试 | SKIP LOCKED、租约、超时回收 | 两个 Worker 不重复领取；超时任务被回收 |
| 渲染测试 | 固定参数渲染出片、缩略图、时长/分辨率规格 | 输出 1080×1920 / 30fps / MP4；中文字体正常 |
| E2E 冒烟 | 注册 → 上传 → 生成 → 渲染 → 下载 → 额度核对 | 全链路一次跑通 |
| 压测 | 渲染耗时、并发领取、磁盘 IO | 确认单任务渲染时长与并发上限，校准扩缩容阈值 |

测试数据须脱敏；AI 调用在测试中一律 Mock，避免产生真实费用。

## 16. 实施路线图（对齐 30 天）

本章将 30 天计划拆解到任务与验收命令，便于按天推进与验收。

| 阶段 | 时间 | 任务 | 验收 |
|------|------|----------|------|
| 阶段一 | Day 1～3 | 初始化 Next.js + Remotion；建 6 张表 DDL 与迁移脚本；AI/Schema 契约定义 | 项目可运行；迁移可重复执行 |
| 阶段二 | Day 4～6 | 商品 JSON Schema、模板参数契约、Zod 校验 | 参数化生成单测通过 |
| 阶段三 | Day 7～10 | 开发首批模板；预览与正式渲染封装；缩略图生成 | 固定参数可渲染出片，规格正确 |
| 阶段四 | Day 11～13 | 完整渲染链路；文件抽象；上传校验 | E2E 端到端闭环跑通 |
| 阶段五 | Day 14～16 | 商品管理 CRUD；图片上传；鉴权下载 | 商品 CRUD 与归属校验通过 |
| 阶段六 | Day 17～19 | Worker 领取协议、租约、超时回收、重试 | 队列与幂等测试通过 |
| 阶段七 | Day 20～22 | AI 文案、额度扣减/返还、用量记录 | 额度原子性与失败返还验证通过 |
| 阶段八 | Day 23～25 | 页面整合；任务状态轮询；异常态与四态设计 | 前端闭环可用 |
| 阶段九 | Day 26～28 | VPS 部署、Nginx、PM2、备份、监控告警 | 线上冒烟通过；告警可触发 |
| 阶段十 | Day 29～30 | 压测与加固；客户试用与反馈 | 阈值校准；问题清单收敛 |

## 17. 风险、依赖与技术债

| 编号 | 风险/依赖 | 等级 | 应对 |
|------|-----------|------|------|
| RK-01 | Remotion 商用授权资格未确认 | 高 | 上线前核对许可条款并计入预算；未确认不得商用 |
| RK-02 | 单任务渲染时长超预期 | 中 | 压测校准分辨率/并发；必要时降预览成本、优化模板 |
| RK-03 | 本地磁盘容量与单点故障 | 中 | 留存期限 + 容量告警 + 定期备份；按阈值切对象存储 |
| RK-04 | AI 输出质量不稳定或成本失控 | 中 | Schema 强校验、重试降级、缓存与 token 监控 |
| RK-05 | 队列卡死/重复执行 | 中 | SKIP LOCKED + 租约 + 超时回收 + 幂等索引 |
| RK-06 | 参数快照与模板版本不匹配 | 低 | input_json 存模板版本；模板变更做兼容处理 |
| RK-07 | 早期刻意简化带来的技术债 | 低 | 通过抽象层与扩展阈值管控，避免在业务代码里堆临时方案 |

---

本方案为技术设计参考，具体实施请结合公司合规、法务与安全要求确认；文中版本、阈值与容量均为建议值，需以实际压测与许可证核对结果为准。
