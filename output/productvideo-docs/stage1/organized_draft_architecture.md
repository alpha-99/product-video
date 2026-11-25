# 电商商品视频生成器：简化版技术架构与实施方案

根据前面的讨论，重新整理整个技术方案。本次以个人独立开发、低成本部署、本地文件存储、Remotion 视频渲染为核心原则，去掉不必要的基础设施。

产品定位仍然是：面向中小电商商家，上传商品图片和信息，自动生成具有品牌感的商品推广短视频。

## 一、架构设计原则

整个项目遵循以下原则：

- **简单优先**：尽量使用成熟框架，不引入不必要的中间件。
- **单体优先**：采用模块化单体架构，不拆分微服务。
- **本地存储**：商品图片、视频、缩略图统一存储在 VPS 本地磁盘。
- **异步渲染**：视频渲染独立于 HTTP 请求，避免请求超时。
- **AI 参数化**：AI 负责生成商品文案和视频参数，不直接生成 React 代码。
- **渐进式扩展**：有真实业务压力后再引入 Redis、对象存储和分布式渲染。

## 二、整体技术架构

整个系统由六层组成：

| 层次 | 说明 |
|------|------|
| 用户访问层 | 浏览器 · 商品管理 · 模板选择 · 视频预览 · 下载 |
| Next.js 应用层 | 页面 · API · 用户认证 · 商品管理 · 视频任务管理 · 订阅管理 |
| 业务数据层 | Supabase PostgreSQL：用户、商品、任务、订单 |
| AI 服务层 | OpenAI / Claude API：文案生成、卖点提取 |
| 视频处理层 | Node.js Worker + Remotion + FFmpeg：任务领取、模板渲染、视频编码、缩略图生成 |
| 本地文件存储层 | VPS 持久化磁盘：商品图片、临时文件、MP4、缩略图 |

这里采用模块化单体架构，但渲染 Worker 是独立运行进程。它们可以在同一台 VPS、同一个代码仓库中部署，不代表需要拆成多个微服务。

## 三、技术组件选型

| 模块 | 技术选型 | 主要职责 |
|------|----------|----------|
| 前端 | Next.js + React | 用户界面 |
| UI 组件 | Tailwind CSS + shadcn/ui | 页面和交互 |
| 后端 | Next.js API | 业务接口 |
| 数据库 | Supabase PostgreSQL | 业务数据 |
| 身份认证 | Supabase Auth | 用户登录 |
| 视频框架 | Remotion | 视频模板和渲染 |
| 视频编码 | FFmpeg | 音视频处理 |
| 后台任务 | Node.js Worker | 异步任务执行 |
| 文件存储 | 本地文件系统 | 图片和视频 |
| AI 服务 | OpenAI / Claude | 商品文案生成 |
| 部署 | Ubuntu VPS | 应用和渲染运行环境 |
| Web 服务 | Nginx | 反向代理、静态文件访问 |

**明确不引入**：Redis、BullMQ、AWS Lambda、S3 / Cloudflare R2、Elasticsearch、Kubernetes、微服务架构。这些组件并非不好，而是目前的业务规模不需要它们。

## 四、核心业务模块设计

建议将系统划分为 7 个业务模块：

| 模块 | 职责 | 核心功能 |
|------|------|----------|
| 用户模块 | 用户身份管理 | 注册、登录、用户信息 |
| 商品模块 | 商品信息管理 | 商品资料、图片上传、编辑 |
| AI 文案模块 | 营销内容生成 | 标题、卖点、CTA |
| 模板模块 | 视频模板管理 | 模板列表、模板配置 |
| 渲染模块 | 视频生成 | 参数组装、Remotion 渲染 |
| 任务模块 | 视频任务管理 | 创建、执行、状态、重试 |
| 文件模块 | 文件管理 | 上传、下载、删除、清理 |

建议使用模块化目录组织代码，每个模块管理自己的业务逻辑，不要让 API、数据库访问和渲染逻辑混在一起。

## 五、项目目录结构

```text
product-video/
│
├── app/                         # Next.js 页面和 API
│   ├── (auth)/                  # 登录注册页面
│   ├── dashboard/               # 用户工作台
│   ├── products/                # 商品管理
│   ├── videos/                  # 视频管理
│   ├── templates/               # 模板选择
│   └── api/
│       ├── products/
│       ├── videos/
│       └── templates/
│
├── src/
│   ├── modules/
│   │   ├── user/
│   │   ├── product/
│   │   ├── ai-content/
│   │   ├── template/
│   │   ├── render/
│   │   ├── video-job/
│   │   └── file/
│   │
│   ├── infrastructure/
│   │   ├── database/
│   │   ├── storage/
│   │   ├── ai/
│   │   └── remotion/
│   │
│   ├── shared/
│   │   ├── types/
│   │   ├── schemas/
│   │   ├── constants/
│   │   └── utils/
│   │
│   └── config/
│
├── remotion/                    # Remotion 视频项目
│   ├── compositions/
│   │   ├── product-launch/
│   │   ├── product-highlight/
│   │   ├── product-sale/
│   │   └── product-showcase/
│   │
│   ├── components/
│   ├── assets/
│   └── Root.tsx
│
├── worker/                      # 后台任务执行程序
│   ├── index.ts
│   └── render-worker.ts
│
├── scripts/
│   ├── cleanup.ts
│   └── migrate.ts
│
├── prisma/                      # 数据库 Schema（如果选择 Prisma）
│   └── schema.prisma
│
├── data/                         # 本地持久化数据
│   ├── uploads/
│   ├── renders/
│   ├── videos/
│   └── thumbnails/
│
├── package.json
└── README.md
```

说明：数据库访问建议在 Prisma 和 Supabase 客户端之间选择一种主要方式，不要重复引入两套 ORM / 数据访问体系。若使用 Supabase Auth，可采用 Supabase 客户端管理认证，Prisma 负责业务数据库访问；MVP 也可以直接统一使用 Supabase 客户端和 SQL。

## 六、数据库设计

初期建议 6 张核心业务表。

### 6.1 users

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 用户 ID |
| email | VARCHAR | 邮箱 |
| created_at | TIMESTAMP | 创建时间 |

用户身份可以直接关联 Supabase Auth 用户 ID。

### 6.2 products

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 商品 ID |
| user_id | UUID | 所属用户 |
| name | VARCHAR | 商品名称 |
| description | TEXT | 商品描述 |
| price | DECIMAL | 商品价格 |
| image_path | TEXT | 商品图片路径 |
| selling_points | JSONB | 商品卖点 |
| created_at | TIMESTAMP | 创建时间 |

### 6.3 video_templates

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 模板 ID |
| name | VARCHAR | 模板名称 |
| category | VARCHAR | 模板类别 |
| thumbnail_path | TEXT | 模板预览图 |
| config | JSONB | 模板配置 |
| enabled | BOOLEAN | 是否启用 |

### 6.4 video_jobs

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 任务 ID |
| user_id | UUID | 用户 ID |
| product_id | UUID | 商品 ID |
| template_id | UUID | 模板 ID |
| status | VARCHAR | 任务状态 |
| input_json | JSONB | 渲染参数 |
| output_path | TEXT | 输出视频路径 |
| error_message | TEXT | 错误信息 |
| created_at | TIMESTAMP | 创建时间 |
| completed_at | TIMESTAMP | 完成时间 |

### 6.5 subscriptions

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 订阅 ID |
| user_id | UUID | 用户 ID |
| plan | VARCHAR | 套餐 |
| status | VARCHAR | 订阅状态 |
| expires_at | TIMESTAMP | 到期时间 |

### 6.6 usage_records

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 记录 ID |
| user_id | UUID | 用户 ID |
| video_job_id | UUID | 视频任务 |
| usage_type | VARCHAR | 使用类型 |
| amount | DECIMAL | 消耗量 |
| created_at | TIMESTAMP | 创建时间 |

第一版也可以暂缓订阅和用量表，先用简单的用户额度字段验证付费模式。

## 七、本地文件存储设计

文件全部放在 VPS 持久化磁盘中。

### 7.1 目录结构

```text
/opt/product-video/data/
│
├── uploads/
│   └── {user_id}/
│       ├── product_001.jpg
│       └── product_002.jpg
│
├── renders/
│   └── {job_id}/
│       ├── input.json
│       └── temp.mp4
│
├── videos/
│   └── {user_id}/
│       └── {job_id}.mp4
│
└── thumbnails/
    └── {user_id}/
        └── {job_id}.jpg
```

### 7.2 文件访问原则

- **上传文件**：后端接收并校验，保存到本地。
- **渲染过程**：使用独立临时目录。
- **视频输出**：渲染成功后移动到正式视频目录。
- **视频下载**：通过受鉴权的 API 返回文件。
- **文件删除**：同时删除磁盘文件和对应数据库记录。

**特别注意**：不要直接把 data 目录映射为公开静态目录。视频下载需要先校验用户身份和文件所属关系，避免用户通过修改 URL 访问其他用户的视频。

### 7.3 文件存储接口

建议封装统一接口：

```typescript
export interface FileStorage {
  save(
    file: Buffer,
    relativePath: string
  ): Promise<string>;

  read(
    relativePath: string
  ): Promise<Buffer>;

  delete(
    relativePath: string
  ): Promise<void>;

  exists(
    relativePath: string
  ): Promise<boolean>;
}
```

第一版只实现 `LocalFileStorage`，未来需要云存储时再增加其他实现。

## 八、Remotion 视频生成模块

这是整个产品最核心的技术资产。

### 8.1 视频生成流程

1. **接收商品信息**：商品名称、图片、价格、卖点、品牌色。
2. **AI 生成营销文案**：生成标题、字幕、卖点、CTA。
3. **校验 JSON 参数**：使用 Zod 校验字段、长度、格式。
4. **选择 Remotion Composition**：根据用户选择确定视频模板。
5. **执行 Remotion 渲染**：使用固定模板和商品参数生成 MP4。
6. **生成缩略图**：使用 Remotion 截帧或 FFmpeg 生成封面。
7. **保存结果**：视频和缩略图写入本地文件系统，更新任务状态。

### 8.2 模板参数示例

```typescript
interface ProductVideoProps {
  title: string;
  subtitle: string;
  imageUrl: string;
  price?: string;
  sellingPoints: string[];
  cta: string;
  brandColor: string;
}
```

AI 只负责填充这些参数，动画、排版、字体、背景、转场均由开发者控制。

### 8.3 第一批模板

| 模板 | 时长 | 主要内容 |
|------|------|----------|
| Product Launch | 15 秒 | 新品展示 |
| Product Highlight | 20 秒 | 商品卖点 |
| Product Sale | 15 秒 | 促销活动 |
| Premium Showcase | 20 秒 | 高级品牌展示 |

首期视频统一使用竖屏 9:16，1080 × 1920 输出；开发和测试时可以使用低分辨率预览，减少渲染成本。

## 九、后台任务设计

不引入 Redis 和 BullMQ，直接使用 PostgreSQL 实现轻量任务队列。

### 9.1 任务执行流程

```text
用户提交生成请求
        |
        v
创建 video_jobs
status = pending
        |
        v
Node.js Worker 查询待处理任务
        |
        v
领取任务并锁定
status = processing
        |
        v
调用 Remotion
        |
        v
保存本地 MP4
        |
        v
更新任务状态
        |
        v
completed / failed
```

### 9.2 Worker 运行方式

Worker 独立于 Next.js HTTP 请求运行，但不需要单独的服务器。

```bash
# 启动 Web 应用
npm run start

# 启动渲染 Worker
npm run worker
```

生产环境通过 PM2 或 systemd 保持进程运行。建议初期只允许一个渲染任务同时执行，后续根据 CPU 和内存测试结果调整。

## 十、部署架构与资源预算

### 10.1 部署方式

建议一台 Ubuntu VPS：

| 服务 | 部署位置 |
|------|----------|
| Nginx | VPS |
| Next.js | VPS |
| Node.js Worker | VPS |
| Remotion | VPS |
| FFmpeg | VPS |
| 文件系统 | VPS 持久化磁盘 |
| PostgreSQL | Supabase 托管 |
| 用户认证 | Supabase Auth |

### 10.2 服务器建议

- **初期推荐配置**：2 vCPU / 4 GB RAM，适合低并发 MVP，需通过实际视频渲染压测验证。
- **系统**：Ubuntu LTS。
- **磁盘**：至少 50 GB SSD，按视频留存量增加。
- **渲染**：单任务并发。
- **Web**：Nginx 反向代理。
- **进程**：PM2 或 systemd。

### 10.3 月度成本估算

| 项目 | 预算 |
|------|------|
| VPS | $10～30 |
| 域名 | $1～2 |
| Supabase | $0～25 |
| AI API | $5～30 |
| 其他 | $0～10 |
| 合计 | 约 $16～97/月 |

这里是早期估算，不包含 Remotion 可能产生的授权费用、税费和支付手续费。正式商用前应根据实际许可证资格核对 Remotion 授权要求。

## 十一、30 天开发计划

按照你选择的美妆护肤、高级品牌感、优先实现视频引擎的方向，重新安排开发顺序。

| 时间 | 开发任务 | 验收结果 |
|------|----------|----------|
| Day 1～3 | 初始化 Next.js、Remotion 项目 | 项目运行 |
| Day 4～6 | 商品 JSON Schema、模板参数 | 参数化能力 |
| Day 7～10 | 开发 3 套视频模板 | 可生成视频 |
| Day 11～13 | 视频预览和渲染封装 | 完整视频链路 |
| Day 14～16 | PostgreSQL 数据库和商品管理 | 商品 CRUD |
| Day 17～19 | 本地文件存储模块 | 图片上传、视频保存 |
| Day 20～22 | Worker 和任务管理 | 异步渲染 |
| Day 23～25 | AI 文案生成 | 自动卖点和标题 |
| Day 26～27 | 用户界面整合 | MVP 可用 |
| Day 28～29 | VPS 部署和测试 | 线上运行 |
| Day 30 | 客户试用和反馈 | 商业验证 |

## 十二、最终技术架构清单

| 项目 | 方案 |
|------|------|
| 架构模式 | 模块化单体 |
| 前端和业务 API | Next.js + React |
| 业务数据和用户认证 | Supabase PostgreSQL |
| 视频模板和渲染 | Remotion + FFmpeg |
| 异步任务执行 | Node.js Worker |
| 本地图片和视频存储 | Local File Storage |
| 商品文案生成 | OpenAI / Claude |
| 部署和访问入口 | Ubuntu VPS + Nginx |

**明确暂不使用**：Redis、BullMQ、S3 / R2、AWS Lambda、Kubernetes、微服务。

**关键约束**：Next.js Web 进程与 Remotion Worker 虽然共享代码仓库，但必须作为独立进程运行。Worker 使用 PostgreSQL 领取任务，并通过事务锁避免重复执行。

## 最终结论

这套架构足以支撑你从 MVP 到早期副业商业化。最重要的是先把 Remotion 模板库和渲染链路做好，再围绕商品管理、AI 文案和任务管理做产品化。

本地存储方案有一个明确前提：服务器必须有持久化磁盘、足够的容量和备份策略；同时要设置视频留存期限和磁盘使用量告警。这样既能保持架构简单，也能避免后期因为磁盘满或服务器故障导致业务数据丢失。
