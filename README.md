# ProductVideo AI 开发指南

> 面向本地开发与联调：如何启动、如何调试前端与后端、如何排障。
> 最后更新：2026-11-27（阶段一～九已完成，部署配置见 `deploy/`；新增 §8「管理员账号使用方式」——属模板管理补全方案，**业务代码待落地**，详见该章状态说明）。

## 0. 先看架构

```text
浏览器 ──> Next.js 14 (页面 + /api/*) ──> PostgreSQL (Supabase / pooler)
                    │                            │
                    │ 提交任务写 video_jobs      │ SKIP LOCKED 领取
                    └────────────────────> Worker 进程 ──> Remotion 渲染 ──> MP4 / 缩略图
                                                  │
                                                  └──> DeepSeek 文案（/api/ai/copy 独立调用）
```

- **Web 与 Worker 是两个进程**，不共享内存，只通过 `video_jobs` 表通信；Worker 不监听端口。
- 所有请求/响应契约在 `src/shared/`（Zod Schema），前后端共用；API 统一包络 `{ ok, data }` / `{ ok: false, error }`。
- 渲染产物落在 `STORAGE_ROOT`（默认 `<repo>/data`），生产为 `/opt/product-video/data`。

## 1. 环境准备

| 依赖 | 要求 |
|---|---|
| Node.js | >= 20（实测 22 LTS 可用） |
| 数据库 | PostgreSQL 15+；本项目用 Supabase **Session Pooler（IPv4）** |
| 浏览器 | Remotion 渲染会自动下载 Chrome Headless Shell + FFmpeg，无需手工安装 |

```bash
npm install                 # 或 npm ci
npx prisma generate         # 首次 / 每次改 prisma/schema.prisma 后必须执行
npm run migrate             # 按顺序应用 db/migrations/*.sql（幂等，含 4 套模板种子）
npm run migrate:check       # 校验表与索引
npm run db:check            # 只读自检：连通性 / 7 张表 / RLS / 关键索引
npm run ai:check            # 校验 AI 密钥、地址、该 key 下可用模型
```

> ⚠️ `prisma generate` 前先停掉正在运行的 `next` 服务。Windows 下 Prisma 引擎 DLL 被占用会报 EPERM / 生成失败。

### 1.1 环境变量

配置文件放项目根目录（均已 gitignore）：

| 文件 | 用途 |
|---|---|
| `.env.local` | 本地开发；`next dev` 与所有 `tsx` 脚本都会读 |
| `.env.production` | 生产/PM2；由 `deploy/setup-vps.sh` 生成，模板见 `deploy/env.production.example` |

加载优先级（`src/lib/env.ts`，与 Next.js 一致）：
`已有进程环境变量 > .env.<NODE_ENV>.local > .env.local（非生产）> .env.<NODE_ENV> > .env`

最小必需项：

| 变量 | 说明 | 本地示例 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串 | `postgresql://postgres.<ref>:<encoded-pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres` |
| `AI_API_KEY` | 服务端密钥，绝不进 `NEXT_PUBLIC_*` | `sk-...` |
| `AI_BASE_URL` | 只写到 `/v1`，不带 `/chat/completions` | `https://api.deepseek.com/v1` |
| `AI_MODEL` | 供应商 API 的真实模型 id | `deepseek-flash` |
| `AI_FALLBACK_MODEL` | 备用模型；留空则重试复用主模型 | 留空 |
| `STORAGE_ROOT` | 上传/渲染产物根目录 | 本地建议留空或 `<repo>/data` |
| `PV_AUTH_MODE` | 生产内测登录开关 | 开发不用设；生产内测设 `local` |
| `DEV_SESSION_SECRET` | 本地会话签名密钥，>= 32 字符 | 随机字符串 |
| `PV_COOKIE_SECURE` | HTTPS 才设 `1`；纯 HTTP 必须 `0` | `0` |

完整清单见 `.env.example`（开发）与 `deploy/env.production.example`（生产）。

**数据库连接的三个坑**

1. Supabase 新项目直连域名 `db.<ref>.supabase.co` 是 **IPv6-only**，本机无 IPv6 出口会 `ENOTFOUND`；改用 Dashboard 给出的 **Session/Transaction pooler** 地址。
2. pooler 的用户名必须带项目引用：`postgres.<ref>`，不是裸 `postgres`。
3. 密码含 `? ! * + / @` 时**必须 percent 编码**（`env.ts` 会兜底编码裸字符，但建议直接复制 Dashboard 已编码的串）。`5432` 是 session pooler，可跑迁移；`6543` 是 transaction pooler，需加 `?pgbouncer=true`，且**不能跑迁移**。

本机 `.env.local` 里 `STORAGE_ROOT` 目前指向 `/opt/product-video/data`（生产路径，Windows 上会落到当前盘的 `D:\opt\...`）。本地开发如想让产物落在仓库内，改成项目内绝对路径或留空即可。

## 2. 启动

### 2.1 本地开发（两个终端）

**首选，所有终端通用**：

```bash
# 终端 A：Web —— 前端页面 + 全部 /api 接口（默认 3000）
npm run dev

# 终端 B：Worker —— 不启动的话，提交的任务会永远停在「等待中」
npm run worker
```

打开 **http://localhost:3000/login**，输入任意邮箱 + 至少 8 位密码，首次登录自动建号并给 3 次额度。

> PowerShell 专属：若报 `npm : 无法加载文件 npm.ps1，因为在此系统上禁止运行脚本`，是本机执行策略拦了 `.ps1`。把 `npm` / `npx` 换成 **`npm.cmd` / `npx.cmd`** 即可（实测可用），例如 `npm.cmd run dev`；或一次性执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

#### `NEXT_DIST_DIR=.next-dev npx next dev -p 3000` 到底是什么

这句**不是常规启动命令**，而是 Bash/Git Bash 的特殊写法，只在需要「隔离构建缓存」时才用：

- `NEXT_DIST_DIR=.next-dev` 是 **行内临时环境变量**：`VAR=value command` 只给这一条命令注入变量，命令结束自动失效（实测后续命令读不到它）。
- `next.config.mjs` 里 `distDir: process.env.NEXT_DIST_DIR || ".next"` 会读取它，于是 Next 把缓存写到 `.next-dev/` 而不是 `.next/`，避免与 `next build` 产物互相清理（本机沙箱还会拦截 `next dev` 对 `.next` 的批量删除）。
- `-p 3000` 指定端口；`.next-dev/` 已加入 `.gitignore`。
- ⚠️ **PowerShell / CMD 不支持 `VAR=value command`**，直接粘贴会报「无法将 ... 识别为 cmdlet」或「不是内部或外部命令」。npm 在 Windows 上也是用 `cmd.exe` 执行 scripts，所以不能把这句原样写进 package.json。

各终端的等价写法：

| 终端 | 命令 |
|---|---|
| **任意终端（推荐）** | `npm run dev:isolated` ← 跨平台脚本，见下 |
| Git Bash / Linux / macOS | `NEXT_DIST_DIR=.next-dev npx next dev -p 3000` |
| PowerShell | `$env:NEXT_DIST_DIR = ".next-dev"; npx.cmd next dev -p 3000` |
| CMD | `set NEXT_DIST_DIR=.next-dev && npx next dev -p 3000` |

`npm run dev:isolated` 对应 `scripts/dev.mjs`：由 Node 直接给子进程设置 `NEXT_DIST_DIR` 并调用 `node_modules/next/dist/bin/next dev -p 3000`，**零新增依赖**，Windows/macOS/Linux 行为一致；可用 `PORT=3001` 改端口，`npm run dev:isolated -- --dry-run` 只打印命令不启动服务。PowerShell 那行会污染当前会话变量（需要时 `Remove-Item Env:NEXT_DIST_DIR` 清除），所以更推荐脚本版。

> 另一个本机专属坑：`npx tsx -e "..."` 会静默挂起，临时诊断脚本一律写成 `.ts` 文件再 `npx tsx scripts/xxx.ts`。

### 2.2 用生产构建本地验证

适合复现线上行为（含 `PV_AUTH_MODE=local` 登录）：

先 `npm run build`，再按终端二选一（下面多处行内赋值同样是 **Bash 语法**）：

```bash
# Git Bash / Linux / macOS
npm run build
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | sed 's/^DATABASE_URL=//' | tr -d '\r')"
NODE_ENV=production PV_AUTH_MODE=local \
  DEV_SESSION_SECRET=local-dev-session-secret-0123456789abcdef \
  PV_COOKIE_SECURE=0 npx next start -p 3000
```

```powershell
# PowerShell（$env: 前缀，不要用 VAR=value；用 .cmd 绕开执行策略）
npm.cmd run build
$line = (Select-String -Path .env.local -Pattern '^DATABASE_URL=').Line
$env:DATABASE_URL = $line -replace '^DATABASE_URL=', ''
$env:NODE_ENV = "production"
$env:PV_AUTH_MODE = "local"
$env:DEV_SESSION_SECRET = "local-dev-session-secret-0123456789abcdef"
$env:PV_COOKIE_SECURE = "0"
npx.cmd next start -p 3000
```

- 生产模式默认 **fail-closed**：`POST /api/auth/session` 返回 403，只认 Supabase Bearer JWT。要跑本地登录必须显式开 `PV_AUTH_MODE=local` 且密钥 >= 32 位。
- 显式注入 `DATABASE_URL` 是因为生产模式下 `.env.local` 不在 `tsx`/`env.ts` 的加载链里；若 `/api/health` 里 DB 显示不可用，先检查这一点。
- `PV_COOKIE_SECURE=1` 在纯 HTTP 下浏览器不会保存 Cookie，表现为"登录成功但接口全 401"。

### 2.3 进程一览

| 命令 | 端口 | 作用 |
|---|---|---|
| `npm run dev` | 3000 | 前端 + API，热更新（首选） |
| `npm run dev:isolated` | 3000 | 同上，但缓存写 `.next-dev/`；`.next` 被占用/清理被拦时用 |
| `npm run worker` | 无 | 2s 领任务 / 30s 回收超时租约 / 15s 写心跳 |
| `npm run studio` | 默认 3000 | Remotion Studio，调模板时间轴；与 Next 冲突时加 `--port 3001` |
| `npx next start -p 3000` | 3000 | 生产构建产物 |

Worker 关键日志前缀：`[worker] ready` / `[worker] job=... status=...` / `[worker] reclaim: ...` / `[worker] heartbeat error`。

## 3. 前端调试

### 3.1 页面清单

| 路由 | 页面 | 主要接口 |
|---|---|---|
| `/login` | 登录注册 | `POST /api/auth/session` |
| `/` | 工作台（额度/统计/最近生成） | `/api/me`、`/api/videos` |
| `/products` | 商品增删改 + 图片上传 | `/api/products`、`/api/uploads/products` |
| `/templates` | 4 套模板卡片 | `/api/templates` |
| `/create` | 6 步创作向导、AI 文案、9:16 预览 | `/api/products`、`/api/templates`、`/api/ai/copy`、`POST /api/videos` |
| `/videos` | 任务列表、播放/下载/重新生成/取消/删除 | `/api/videos`、`/api/videos/[id]/*` |
| `/preview?t=product-launch` | Remotion Player 模板联调页 | 无（纯前端） |

`?t=` 可选值：`product-launch` / `product-highlight` / `product-sale` / `product-showcase`。

### 3.2 数据流与缓存（调试时最容易踩）

```text
页面组件 → useAsync(loader, { cacheKey }) → api.get(path) → /api/*
                │                              │
                ├─ 共享缓存 src/lib/client/cache.ts   └─ 同 path 的 GET 自动去重
                └─ loading 仅在「完全无数据」时为 true（stale-while-revalidate）
```

- 菜单切换不会重新挂载 `AppShell`，但会重新挂载页面组件；`useAsync` 命中缓存时**立即渲染旧数据 + 后台静默刷新**，所以不会每次都闪骨架屏。
- `AppShell` 登录后空闲预热 `templates / products / videos`；退出登录会清空缓存。
- 调试时看到"旧数据"：点页面上的刷新/reload、硬刷新浏览器，或退出重新登录。硬刷新会清空模块级缓存。
- `reactStrictMode: true`，开发环境 effect 会执行两次，Network 面板看到成对请求是正常现象（GET 已做 in-flight 去重）。
- 视频页用 `usePolling` 每 5 秒刷新，**仅在存在 pending/processing 任务时启动**，页面隐藏时暂停。
- 四态组件统一在 `src/components/ui.tsx`：`Skeleton`（加载）/ `ErrorBanner`（错误 + 重试）/ `EmptyState`（空）/ `BoundaryCard`（额度耗尽等边界）。设计 token 在 `src/app/globals.css`，参照 `ProductVideo_AI_UI设计方案.html` 与 `UI设计稿_PNG/`。

### 3.3 排查手法

- **Console / Network**：`api.ts` 把错误码映射成中文文案；401 会自动 `window.location.assign('/login')`；4xx 不重试，5xx 退避 3 次（300/600/1200ms）。
- **看真实响应**：所有接口返回 `{ ok, data }`，先看 `ok` 再看 `data`。
- **Toaster**：右上角轻量提示，失败操作会 `toast.show(message, true)`。
- **模板视觉**：`/preview?t=...` 低分辨率实时预览；`npm run studio` 拖时间轴看逐帧。

## 4. 后端调试

### 4.1 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| POST / GET / DELETE | `/api/auth/session` | 登录 / 当前会话 / 退出 |
| GET | `/api/me` | 当前用户与剩余额度 |
| GET / POST | `/api/products` | 商品列表 / 新建 |
| GET / PATCH / DELETE | `/api/products/[id]` | 单个商品 |
| POST / GET | `/api/uploads/products` | 图片上传 / 鉴权读取 |
| GET | `/api/templates` | 已启用模板（4 套，按 compositionId 去重） |
| POST | `/api/ai/copy` | AI 文案（10 次/分钟/用户限流，24h 缓存） |
| GET / POST | `/api/videos` | 任务列表 / 幂等提交（扣额度） |
| GET / DELETE | `/api/videos/[id]` | 详情 / 取消（返还额度）；`?purge=1` 删除终态任务记录与成片文件 |
| POST | `/api/videos/[id]/retry` | failed / cancelled 重试：复用原 job，先返还再占用额度 |
| POST | `/api/videos/[id]/regenerate` | completed 重新生成：按 input_json 原参数快照新建独立 job，重新占用 1 额度；必带 `Idempotency-Key` |
| GET | `/api/videos/[id]/download` | 鉴权下载成片（非 JSON 包络） |
| GET | `/api/health` | 真实探测：DB / 磁盘 / 队列积压 / Worker 心跳 |

> **重新生成双路径（C-06）**：`failed / cancelled` 走 retry，`completed` 走 regenerate。
> 后者不接受客户端传参，服务端从原任务的 `input_json` 快照反解文案与选项，
> 复用 `createVideoJob` 的事务完成归属校验、额度扣减与幂等保护。
> 删除终态任务时会先把 `usage_records.video_job_id` 置空以保留额度流水审计，
> 成片文件清理在 DB 事务外执行，失败只记结构化告警。

### 4.2 用 curl 调接口（不依赖浏览器）

```bash
# 1) 登录并保存 HttpOnly Cookie
curl -c /tmp/pv.cookie -X POST -H 'content-type: application/json' \
  -d '{"email":"dev@example.com","password":"abcd1234"}' \
  http://127.0.0.1:3000/api/auth/session

# 2) 带 Cookie 调业务接口
curl -b /tmp/pv.cookie http://127.0.0.1:3000/api/me
curl -b /tmp/pv.cookie http://127.0.0.1:3000/api/templates
curl -b /tmp/pv.cookie http://127.0.0.1:3000/api/videos?take=100

# 3) 开发模式可用头注入用户（仅 NODE_ENV !== production）
curl -H 'x-dev-user-id: <user-uuid>' http://127.0.0.1:3000/api/products
```

生产正式模式用 `Authorization: Bearer <Supabase JWT>`（`SUPABASE_JWT_SECRET` 校验 HS256）。

### 4.3 健康检查与巡检

```bash
curl -sS http://127.0.0.1:3000/api/health | jq .        # 200=ok/degraded，503=down
npm run ops:check                                        # 命令行直连探测（不依赖 Web 端口）
npm run ops:check -- --url http://127.0.0.1:3000/api/health --json --strict
npm run ops:alert -- --force                             # 验证告警链路（未配 webhook 只打 dry-run）
npm run ops:alert -- --reset                             # 清空告警去重状态
```

报告里的 `issues` 字段是排障第一入口。本机常见 `degraded` 原因就是 **Worker 未启动 → 无心跳**。配置 `HEALTH_TOKEN` 后需带 `x-health-token` 头或 `?token=`。

线上/部署后的完整链路冒烟：

```bash
npx tsx scripts/ops-smoke.ts --full        # 登录→上传→建商品→真实 AI→提交→等渲染→下载→额度核对
npx tsx scripts/ops-smoke.ts --keep        # 保留测试数据供排查
BASE_URL=https://your.domain npx tsx scripts/ops-smoke.ts --full
```

`--full` 会真实调用 AI（产生 token 费用）并等待 Worker 渲染（最长 6 分钟），执行前确认 `npm run worker` 已在运行；只验基础链路用不带参数的版本即可。

### 4.4 AI 文案

```bash
npm run ai:check                # 配置 + GET /models 列出该 key 可用模型
npm run ai:check -- --generate  # 真实出稿一次（会产生 token 费用）
```

- 模型 id **不能从 key 猜**，用 `ai:check` 列出来再填 `AI_MODEL`。当前环境是 `deepseek-flash`。
- 失败重试 2 次、1s/2s 退避，401/403 立即终止；全失败返回 `AI_UNAVAILABLE`(503)，前端自动切「手工填写」。
- 命中 `ai_copy_cache`（24h）不再调模型；每次真实调用写一条 `usage_records.ai_call`（`amount=0`，**不扣额度**，额度只在提交视频任务时扣）。
- 换供应商时改 `AI_BASE_URL` + `AI_MODEL` 即可，客户端是 OpenAI 兼容 `/chat/completions` + JSON mode。

### 4.5 渲染与队列

```bash
npm run compositions            # 列出 4 个 production composition
npx remotion still remotion/index.ts product-launch output/launch.png --frame=45
npx remotion render remotion/index.ts product-launch output/launch.mp4
npm run render:vendor:still     # 官方免费 HelloWorld 模板静帧（验证 Chrome+FFmpeg 链路）
npm run render:vendor:video     # 3s MP4

npm run render:job -- path/to/input.json   # 用 RenderJobInputSchema 走正式渲染链路
npm run process:job -- <jobId>             # 不启 Worker，手动跑一次「领取→渲染→回写」
npx tsx scripts/ops-storage-audit.ts --strict   # 比对 DB 记录与磁盘文件漂移
```

任务状态机：`pending → processing → completed | failed | cancelled`。`video_jobs` 表含 `lease_until`、`attempts`、`idempotency_key`；失败重试上限 3 次，超时租约 30s 回收。直接查这几个字段比看日志更快定位"卡住的任务"。

### 4.6 日志位置

| 场景 | 位置 |
|---|---|
| 本地 dev / start | 启动终端的 stdout（`[worker]` / Prisma warn+error） |
| PM2 生产 | `logs/web-out.log`、`logs/web-error.log`、`logs/worker-*.log`、`logs/RELEASES.log` |
| 巡检 / 告警 / 备份 | `logs/alert.log`、`logs/backup.log`、`logs/cleanup.log`、`logs/storage-audit.log`（cron 写入） |

## 5. 测试与静态检查

```bash
npm run typecheck                       # tsc --noEmit
npm run lint                            # next lint
npm test                                # 全量 120 用例，连真库
npx tsx --test tests/phase8.test.ts     # 只跑单个文件
npm run build                           # 生产构建（18+ 路由）
```

测试覆盖：Schema 契约、渲染参数、上传校验、商品 CRUD、队列协议、迁移/Schema、AI 文案、阶段八接口、阶段九运维、客户端缓存。

> 全量测试偶发 `Can't reach database server` / `Connection terminated due to connection timeout`：本机到悉尼 pooler 跨境抖动 + 15 个测试文件并行抢连接所致，**不是代码问题**。先停掉本地 `next start` 服务再跑即可（实测 120/120 通过、0 skipped）。不要为此改业务代码。

## 6. 排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `next dev` 启动失败 / 卡在清理缓存 | 本机沙箱拦截 `.next` 批量删除 | `npm run dev:isolated` |
| 粘贴 `VAR=value command` 报「不是内部或外部命令」 | 该语法只在 Bash 生效 | 用 `npm run dev:isolated`，或 PowerShell 写 `$env:VAR = "value"` |
| PowerShell 报「禁止运行脚本 npm.ps1 / npx.ps1」 | 执行策略拦截 `.ps1` | 改用 `npm.cmd` / `npx.cmd`，或 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `prisma generate` 报 EPERM / DLL 占用 | Next 服务占着引擎 | 停服务后重跑 |
| `npx tsx -e` 无输出、像挂起 | 本机执行方式兼容问题 | 写成 `.ts` 文件再 `npx tsx scripts/x.ts` |
| `ENOTFOUND` / `Can't reach database server` | IPv6-only 直连地址、密码未编码、跨境冷启动 | 用 pooler IPv4 串；`npm run db:check` 定位 |
| 模板页显示 0 套 | 迁移未跑 | `npm run migrate` |
| 登录接口 403 | 生产模式默认只认 Supabase JWT | `PV_AUTH_MODE=local` + `DEV_SESSION_SECRET`(>=32) |
| 登录成功但所有接口 401 | `PV_COOKIE_SECURE=1` + HTTP | 改 `0`，或上 HTTPS |
| 任务一直「等待中」 | Worker 没启动 | `npm run worker`；`/api/health` 看心跳 |
| AI 文案提示"暂时不可用" | 未配 key / 模型 id 不存在 / 限流 | `npm run ai:check`；503 会自动降级手填 |
| `/api/health` = degraded | 多为 Worker 心跳缺失或队列积压 | 看 `issues` 字段，`npm run ops:check` |
| 改页面后看到旧数据 | 客户端 SWR 缓存 | 点刷新 / 硬刷新 / 退出登录清缓存 |
| 全量测试偶发失败 | DB 跨境抖动 | 停本地服务后重跑 |

## 7. 部署环境调试（简版）

完整脚本与说明见 `deploy/`：

```bash
sudo bash deploy/setup-vps.sh --domain video.example.com --email ops@example.com  # 首次装机器
bash deploy/deploy.sh --init        # 首次发布；常规用 bash deploy/deploy.sh
pm2 status / pm2 logs pv-web / pm2 logs pv-worker
pm2 reload deploy/ecosystem.config.cjs --update-env
bash deploy/deploy.sh --rollback    # 回滚构建产物（数据库迁移不回滚）
npm run backup / npm run restore    # pg_dump 备份与恢复
```

- Web 与 Worker 是 PM2 里的两个 app：`pv-web`（Next start）、`pv-worker`（tsx Worker），日志与内存上限独立。
- Nginx 配置在 `deploy/nginx/`，`/api/health` 挂监控；cron 在 `deploy/cron/product-video`（每日备份、每分钟告警、每日清理、每周存储审计）。
- 生产环境变量统一从 `.env.production` 读取，密钥不要写进 `ecosystem.config.cjs` 或提交入库。

## 8. 管理员账号使用方式（模板管理补全方案 · 业务代码待落地）

> **先看状态**：本章记录的是 `docs/prd/ProductVideo_AI_模板管理补全设计方案_V1.0.md`（r3）里已拍板的管理员与模板管理端**用法**。
> 截至 2026-11-27，这些能力**尚未实现**：`users.role` 列、`/api/admin/**`、`/admin/*` 页面、`npm run admin:role` 脚本都还不存在。
> 当前版本所有登录用户都是普通用户，直接访问管理端会得到 **404（路由不存在）而不是 403**。
> 下列命令与页面在方案落地并部署后才生效；不要在生产上按本章试跑。

### 8.1 一句话权限模型

| 主体 | 能看到/做什么 | 判定依据 |
|---|---|---|
| 未登录 | 只能看登录页 | 401 |
| 普通 / 付费用户 | 前台模板选择、创作、提交任务；**看不到管理端** | `users.role='user'` |
| 管理员 | 前台 + 管理端模板配置与账号页 | `users.role='admin'`（**只认服务端查库**） |
| 运维 | 仅 bootstrap / 灾备，走部署凭据 | 产品外脚本，不进 Web |

三条不可绕过的红线：**不认请求里的角色声明**（JWT `role` claim / Cookie / `X-Dev-User-Id` 都不作权限依据）；**不存在任何单步把 `role` 写成 `admin` 的 Web 接口**；**角色每次请求都查库，撤销后下一次请求即 403**（不缓存）。

### 8.2 谁能看到「成员与角色」和「模板管理」

| 内容 | 普通用户 | 管理员 |
|---|---|---|
| 前台模板卡片 `/templates`、`GET /api/templates` | 可见（仅启用的 4 套） | 可见 |
| 后台模板管理 `/admin/templates`（编辑/启停/同步/缩略图/审计） | 不可见、打不开、调不通 | 可见 |
| 成员与角色 `/admin/users`（成员列表/复核/变更记录） | 不可见、打不开、调不通 | 可见 |
| 自己的 `role` 字段（`GET /api/me`） | 可见，值为 `user` | 可见，值为 `admin` |

「看不到」是三层同时生效：菜单不渲染（`AppShell` 按 `role` 条件显示）→ 直接输 URL 被页面服务端 gate 拦下 → 直接调 `/api/admin/**` 返回 403 且响应体不含任何数据。URL 字符串本身不是秘密，防线是后两层。

### 8.3 创建管理员的三条通道

| 场景 | 通道 | 谁能发起 | 关键限制 |
|---|---|---|---|
| 首次部署（0 名 admin） | 运维脚本 bootstrap | 持部署凭据的运维 | 一次性授予**主/备 2 名不同账号**；只建 1 名则页面提权永久冻结 |
| 日常新增 | 管理端 `/admin/users` | 现有 admin A 提名 + 另一名 admin B 批准 | 目标不能是自己；理由必填；24h 过期；需 admin ≥ 2 |
| 灾备（≤1 名 admin） | 运维脚本 | 运维 | 页面提权已冻结，脚本补齐后解冻 |

重要界限：**脚本不是随时可用的提权通道**。admin ≥ 2 时脚本执行 `--role admin` 会被拒绝并提示走页面复核；它只保留 bootstrap 与灾备两种用途。

### 8.4 生产 / 预发：bootstrap 脚本（方案落地后可用）

脚本文件 `scripts/set-user-role.ts`，命令 `npm run admin:role`（需同步加入 `package.json` 的 `scripts`）。

```bash
# 1) 先看现有管理员名单（只读，幂等）
npm run admin:role -- --list

# 2) 授予主账号；--actor 填工单号，--actor-email 填执行人邮箱（不得与目标邮箱相同）
npm run admin:role -- \
  --email admin-a@example.com \
  --role admin \
  --actor CHG-2026-1127 \
  --actor-email ops-engineer@example.com \
  --reason "首次部署 bootstrap，工单 CHG-2026-1127"

# 3) 授予备账号（必须是另一个人、另一邮箱）
npm run admin:role -- \
  --email admin-b@example.com \
  --role admin \
  --actor CHG-2026-1127 \
  --actor-email ops-engineer@example.com \
  --reason "首次部署 bootstrap 备用账号，工单 CHG-2026-1127"
```

事务内依次执行：读当前角色 → 校验变更后 admin 数 ≥ 1 → 更新 → 写 `user_role_audit_logs`（`source=script`）→ 提交。四道守卫：

| 守卫 | 不通过的结果 |
|---|---|
| `--actor-email` 与 `--email` 相同 | 拒绝（防自我提权） |
| 目标 email 在 `users` 表无对应行 | 失败（脚本只改角色，不建号） |
| 变更后 admin 数 = 0（降权时） | 拒绝 |
| admin ≥ 2 时授予 admin | 拒绝并提示走页面复核 |
| 重复授予同一角色 | 返回「无变更」，不写重复审计 |

验收：`--list` 显示 2 名不同 admin；`user_role_audit_logs` 有 2 条 `source=script` 记录。脚本纳入 Git 与 Code Review，**禁止用裸 SQL 替代**。

### 8.5 推荐：把 bootstrap 挂到部署钩子

想「部署完就有管理员」又不想留下无审计的写路径，正确做法是自动化**脚本的调用**，而不是在迁移里 `INSERT` admin。在 `deploy/deploy.sh` 的迁移步骤（当前第 92～102 行 `npm ci` → `prisma generate` → `migrate` → `build`）之后加一步：

```bash
# 示意：凭证与目标账号从 .env.production / secrets 注入，不写死在仓库
npm run admin:role -- \
  --email "$BOOTSTRAP_ADMIN_A" \
  --role admin \
  --actor "$DEPLOY_CHANGE_TICKET" \
  --actor-email "$DEPLOY_OPERATOR_EMAIL" \
  --reason "部署钩子 bootstrap，工单 $DEPLOY_CHANGE_TICKET"
```

这样保留脚本全部守卫和审计，效果上仍是「部署完成即完成 bootstrap」。脚本尚不存在，钩子需与脚本一起落地。

### 8.6 日常新增 / 撤销：管理端页面

页面在服务端 gate 之后才渲染，路径：

```text
/admin                          管理后台
├── /admin/templates            模板管理（列表/筛选/编辑/启停/同步/缩略图/审计）
└── /admin/users                成员与角色
    ├── Tab 成员列表            精确 email 搜索 / role 筛选 / 分页；行内「申请设为管理员」「撤销管理员」
    ├── Tab 待复核              可复核的申请（自己发起的不显示批准按钮）
    └── Tab 角色变更记录        只读审计
```

**提权（3 步，双人经手）**

1. admin A 在成员列表用**精确 email**搜到目标 user → 点「申请设为管理员」→ 弹窗填原因并二次确认
2. 申请进入 `pending`，24h 有效；其余 admin 顶部出现待复核红点（不做推送/邮件）
3. admin B 在「待复核」批准；事务内同时完成「改角色 + 写审计 + 关单」。审批人与发起人必须不同（服务端校验 + DB `CHECK` 双保险）

「想升级的人」是被提名、被批准的对象，**没有自助申请入口**；自己给自己提权会被 `ROLE_SELF_CHANGE` 拦下。重复批准幂等返回 200，不重复写审计；审批时会重新检查发起人与目标是否仍符合条件。

**撤销（单人可操作，不需要复核）**

成员列表行内「撤销管理员」→ 二次确认需输入目标邮箱 → 仅允许把 `role` 写成 `user`。守卫：不能改自己、管理员数恒 ≥ 1。被撤权者的会话在撤销当下仍有效，**但下一次请求即 403**。

**只剩 1 名 admin 时**：页面提权入口冻结（409 `ROLE_NEEDS_SECOND_ADMIN`），须由运维用脚本补齐第 2 名后解冻。误操作依据审计的 from/to 精确还原，不整表重置。

### 8.7 本地开发与 E2E 怎么测

本地模式 `NODE_ENV !== "production"` 时可用 `X-Dev-User-Id` 头注入身份（`src/lib/auth.ts`），curl 示例见 §4.2。但注意：**注入的身份仍需满足 `users.role='admin'`**，否则 `requireAdmin` 照样 403。所以需要一条本地 admin 行。

不要把它写进 `db/migrations/*.sql`（迁移会进生产）。建议写独立 dev seed 脚本：

```ts
// scripts/seed-dev-admin.ts（方案落地后新增）
// 1. 从环境变量读 DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD，不写死
// 2. 首行判断 NODE_ENV === "production" 直接退出
// 3. 密码用 src/lib/password.ts 的 hashPassword() 生成 scrypt 串
// 4. 写审计 source=script，与正式 bootstrap 同口径
```

```bash
curl -H 'x-dev-user-id: <本地 admin 的 user-uuid>' \
  http://127.0.0.1:3000/api/admin/users
```

生产环境该头**完全失效且 fail-closed**，不可用于生产用例。

### 8.8 为什么不在建表时内置一个 admin

| 做法 | 为什么不行 |
|---|---|
| 迁移 SQL 里 `INSERT` admin + 写死密码 | `004_ops.sql` 的 `users.password_hash` 在本地登录模式下按 scrypt 校验；哈希进 Git 等于公开默认口令，可被离线爆破 |
| 固定 UUID 的 admin 行 | `001_init.sql` 里 `users.id` 注释明确「与 auth.users.id 一致」；生产走 Supabase JWT 时 `sub` 对不上就登不进来，反而要再造同 id 用户，形成两套身份源 |
| 用种子/裸 SQL 绕过脚本 | 等于开第二条无守卫、无审计的写通道，bootstrap 与复核的守卫全部失效 |
| 共享的「系统管理员」账号 | 审计只记 UUID，追不到自然人；离职后删不了、改角色又被守卫挡，无法回收 |

结论：生产/预发走脚本或部署钩子；本地走独立 dev seed；**迁移 SQL 里不插 admin**。

### 8.9 错误码速查（方案落地后）

| 码 | HTTP | 场景 |
|---|---|---|
| `ROLE_SELF_CHANGE` | 403 | 改自己角色 / 提名自己 |
| `ROLE_DIRECT_GRANT_FORBIDDEN` | 400 | 绕过复核直接写 `role=admin` |
| `ROLE_LAST_ADMIN` | 409 | 撤销后管理员数将为 0 |
| `ROLE_NEEDS_SECOND_ADMIN` | 409 | admin < 2 时提权 |
| `ROLE_APPROVER_CONFLICT` | 403 | 审批人与发起人相同 |

注意：`src/shared/api.ts` 的 `ErrorCode` 是封闭常量且当前没有这些码，落地时必须同步扩展 `ErrorCode`、`httpStatusFor()` 与 `src/lib/errors.ts` 工厂，否则统一包络会落成 500。同样，新增的测试文件必须写进 `package.json` 中显式罗列测试文件的 `test` 脚本，否则根本不会执行。

## 9. 目录结构

```text
src/app/(app)/        6 个业务页面（共享 AppShell 侧栏布局）
src/app/api/          12 个接口路由
src/app/login/        独立登录页
src/app/preview/      Remotion Player 模板预览
src/components/       AppShell / Toaster / ui.tsx（设计系统组件）
src/lib/client/       前端 api.ts / hooks.ts / cache.ts / types.ts
src/lib/              服务端：db / auth / session / queue / pipeline / renderer /
                      storage / billing / ai / ops / health 相关
src/shared/           前后端共用 Zod Schema 与 API 契约
src/worker/           Worker 主循环
remotion/             4 套生产模板 + 免费模板测试入口
prisma/schema.prisma  数据模型
db/migrations/        001 建表 / 002 用量 / 003 模板种子 / 004 运维表（005 模板管理待落地）
scripts/              迁移、自检、巡检、告警、冒烟、渲染 CLI（bootstrap/提权脚本待落地）
deploy/               PM2 / Nginx / 部署 / 备份 / cron / logrotate
tests/                15 个测试文件
```

## 10. 命令速查

| 目的 | 命令 |
|---|---|
| 管理员/模板管理使用方式 | 见 §8（方案待落地，当前不可用） |
| 起前端（首选） | `npm run dev` |
| 起前端（隔离缓存，跨平台） | `npm run dev:isolated` |
| 起 Worker | `npm run worker` |
| 建表 | `npm run migrate` |
| 验证 DB | `npm run db:check` |
| 验证 AI | `npm run ai:check -- --generate` |
| 验证健康 | `npm run ops:check` |
| 全链路冒烟 | `npx tsx scripts/ops-smoke.ts --full` |
| 类型 / Lint | `npm run typecheck` / `npm run lint` |
| 全部测试 | `npm test` |
| 生产构建 | `npm run build` |
