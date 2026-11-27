# ProductVideo AI · 新增模板开发指南

| 项 | 内容 |
|----|------|
| 适用基线 | `docs/prd/ProductVideo_AI_模板管理补全设计方案_V1.0.md`（r3）已落地代码 |
| 核对日期 | 2026-11-27 |
| 适用对象 | 需要新增一套 Remotion 视频模板的前端 / 全栈开发 |
| 前置阅读 | 技术方案 §5.4、§7.1；模板管理补全方案 §4「两层单一真源」 |

---

## 1. 一句话结论

新增一套模板 = **代码发版注册渲染契约**（Remotion 组件 + `TEMPLATES` + `component-map`）+ **数据库落一行运营元数据**（种子 / 管理端同步）+ **同步修改 6 处测试断言** + **全量验证**。

管理端**不能**新增 `compositionId`、**不能**上传或粘贴 Remotion 代码。任何模板都必须先由开发在代码里注册并发版，再由管理员「从注册表同步」生成 DB 行。

---

## 2. 五条不可绕过的硬约束

| # | 约束 | 违反后果 |
|---|------|----------|
| 1 | `compositionId` 必须命中 `TEMPLATES` 注册表 | `getTemplate()` fail-closed 抛错；`createVideoJob` 拒绝提交；前台不展示 |
| 2 | 模板只能停用，不能删除 | `video_jobs.template_id` 外键 + `input_json` 快照需要可追溯；无 DELETE 接口 |
| 3 | 「可用模板数」= `enabled=true` ∧ `composition_id ∈ TEMPLATES`，恒 ≥ 1 | 停用最后一套可渲染模板返回 409 `TEMPLATE_LAST_ENABLED` |
| 4 | 渲染契约在代码层，运营元数据在 DB 层 | 管理员不能改 `compositionId` / `durationSec` / `config`，改展示名/描述/CTA/tone/排序/缩略图/启停无需发版 |
| 5 | 素材地址必须走 `RenderAssetSrcSchema` + `resolveImageSrc()` | 外部 `http(s):` / `file:` / `//` / `..` 一律拒绝，防止 SSRF 与本地文件读取 |

---

## 3. 最容易踩的坑：`id` 与 `category` 强耦合

这是新增第 5 套模板**第一个会红**的地方，务必先读。

`tests/phase2.test.ts:112` 断言：

```ts
assert.equal(t.category, t.id.replace("product-", ""));
```

同时：

- `TemplateDefinition.category` 类型只有 `"launch" | "highlight" | "sale" | "showcase"`；
- `db/migrations/005_template_admin.sql:152` 的 `chk_templates_category` 约束也只放行这 4 个值；
- `TEMPLATE_IDS` 是封闭枚举，新 id 必须唯一。

**结论：在现有 4 类固定枚举下，不可能既新增唯一 id 又满足 `category === id.replace("product-","")`。新增第 5 套模板必须扩展分类枚举。**

推荐做法（路径 A）：

1. 新分类名 `story`，模板 id 取 `product-story`；
2. `template.schema.ts` 的 `category` 联合类型加 `"story"`；
3. 新增幂等迁移放开 DB CHECK。**文件名必须排在 `003_seed_templates.sql` 之前**（实走验证：迁移执行器每轮重跑所有文件并按文件名排序，若用 `006_*.sql` 会在 003 插入 story 种子之后才放开 CHECK，已应用 005 的库会报 `chk_templates_category` 冲突、整个 `npm run migrate` 失败）；本项目实走采用 `db/migrations/002b_template_category.sql`；
4. `tests/phase2.test.ts` 的 compositionId / durationSec 断言数组加新值。

不推荐路径 B（复用现有 4 类之一）：会导致 id 与已有模板撞车，或违反 `category === id` 断言，除非同步放宽该断言——那会削弱契约测试，不建议。

---

## 4. 全流程七步

```
Step 1 写 Remotion 组件  →  Step 2 注册 TEMPLATES/ID
        ↓                            ↓
Step 3 绑定 component-map  →  Step 4 本地预览与逐帧验证
        ↓
Step 5 DB 落行（003 种子 + 已有环境管理端同步）
        ↓
Step 6 同步修改 6 处测试断言  →  Step 7 typecheck / test / build / 冒烟
```

### Step 1 · 写 Remotion 组件

新建 `remotion/BrandStory.tsx`（示例：`product-story`，20s = 600 帧）。

组件必须遵守的约定：

- 类型固定为 `React.FC<ProductVideoProps>`，**Props 只能来自** `src/shared/video-props.schema.ts`，不要自定义 Props 形状；
- 所有动画只依赖 `useCurrentFrame()` / `useVideoConfig()`，保证浏览器预览与服务端渲染逐帧一致（禁止 `Date.now()`、随机数和 CSS 动画）；
- 所有图片必须 `resolveImageSrc(src)` 后交给 `<Img>`，不得直接 `fetch` 或读取本地路径；
- 画布 1080×1920（9:16），现有模板统一 `padding: "90px 84px"`；
- 15s = 450 帧，20s = 600 帧；动画起点/时长按帧写死，不要超过 `durationInFrames`。

可复用的时间函数（`remotion/lib/animations.ts`）：

| 函数 | 签名 | 用途 |
|------|------|------|
| `fadeIn` | `(start, duration) => number` | 淡入，返回 0~1 透明度 |
| `slideUp` | `(start, duration, distance) => number` | 上浮，返回 translateY 像素偏移量 |
| `popIn` | `(start, damping) => number` | spring 弹出，返回 0~1 进度 |
| `breathe` | `(frame, period, amount) => number` | 呼吸缩放，用于 CTA |
| `segmentProgress` | `(frame, start, duration) => number` | 分段线性进度，用于卖点逐个出现 |

代码骨架：

```tsx
import React from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import type { ProductVideoProps } from "../src/shared/video-props.schema";
import { fadeIn, popIn, slideUp } from "./lib/animations";
import { resolveImageSrc } from "./lib/image-src";

/** 模板 E / Brand Story 品牌故事（20s）。 */
export const BrandStory: React.FC<ProductVideoProps> = ({
  title,
  subtitle,
  imageUrl,
  price,
  sellingPoints,
  cta,
  brandColor,
  logoPath,
}) => {
  const frame = useCurrentFrame();
  const titleY = slideUp(10, 24, 80);
  const titleScale = popIn(10, 14);
  const imageOpacity = fadeIn(24, 24);

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#f8f7ff",
        color: "#111827",
        fontFamily:
          '"Plus Jakarta Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
        padding: "90px 84px",
      }}
    >
      <div style={{ opacity: fadeIn(0, 12), fontSize: 26, letterSpacing: 8 }}>
        BRAND STORY
      </div>
      <div
        style={{
          marginTop: 50,
          transform: `translateY(${titleY}px) scale(${0.96 + titleScale * 0.04})`,
          transformOrigin: "left center",
        }}
      >
        <div style={{ fontSize: 76, fontWeight: 800, color: brandColor }}>{title}</div>
        <div style={{ fontSize: 34, marginTop: 20, color: "#5b6472" }}>{subtitle}</div>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", opacity: imageOpacity }}>
        <Img
          src={resolveImageSrc(imageUrl)}
          style={{ width: "100%", height: 820, objectFit: "contain" }}
        />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        {sellingPoints.slice(0, 3).map((point, i) => (
          <div key={`${point}-${i}`} style={{ fontSize: 26, padding: "12px 22px" }}>
            {point}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 36, display: "flex", justifyContent: "space-between" }}>
        <div style={{ fontSize: 58, fontWeight: 800 }}>{price ?? ""}</div>
        <div
          style={{
            backgroundColor: brandColor,
            color: "#fff",
            fontSize: 34,
            fontWeight: 700,
            padding: "22px 46px",
            borderRadius: 999,
          }}
        >
          {cta}
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

> 可选字段处理：`price` / `originalPrice` / `discountText` / `logoPath` / `musicPath` 都是可选的，未提供时必须有合理降级（不显示或用占位），参考 `remotion/ProductSale.tsx:114` 与 `remotion/ProductLaunch.tsx:59`。`musicPath` 本期尚未接入音频轨道，只需让它通过安全校验即可。

### Step 2 · 注册渲染契约

改 `src/shared/template.schema.ts`，三处：

**2.1 `TEMPLATE_IDS` 加新 id**（封闭枚举，所有下游都从这里派生）：

```ts
export const TEMPLATE_IDS = [
  "product-launch",
  "product-highlight",
  "product-sale",
  "product-showcase",
  "product-story", // 新增
] as const;
```

**2.2 `TemplateDefinition.category` 扩展分类**（见 §3）：

```ts
category: "launch" | "highlight" | "sale" | "showcase" | "story";
```

**2.3 `TEMPLATES` 数组追加一条定义**：

```ts
{
  id: "product-story",
  name: "Brand Story 品牌故事",
  category: "story",
  compositionId: "product-story",
  durationSec: 20,          // 只允许 15 或 20
  ...VIDEO_SPEC,            // 1080×1920 / 30fps / 9:16 / MP4 H.264
  defaultProps: { ...baseDefaultProps, brandColor: "#4f46e5" },
  sampleProps: {
    title: "手作香氛礼盒",
    subtitle: "一段气味构成的故事",
    imageUrl: sampleImageUrl("#a5b4fc", "#312e81"),
    sellingPoints: ["天然植物蜡", "48 小时留香", "可替换内芯"],
    cta: "探索系列",
    price: "¥268",
    brandColor: "#4338ca",
  },
},
```

区分两组 Props，不要混用：

- `defaultProps`：Composition 的默认参数，必须能通过 `ProductVideoPropsSchema`；
- `sampleProps`：模板选择页卡片播放用的演示数据，**必须与 `defaultProps.imageUrl` 不同**（`tests/template-preview.test.ts:61` 会断言），且必须通过 `ProductVideoPropsSchema`；
- `sampleImageUrl(light, dark)` 可生成透明底瓶身剪影的 SVG data URL，保证缩略与播放观感一致。

### Step 3 · 绑定组件映射

改 `remotion/component-map.ts`。`COMPONENTS` 的类型是 `Record<TemplateId, FC<ProductVideoProps>>`，漏绑会直接类型报错——这是编译期的兜底：

```ts
import { BrandStory } from "./BrandStory";

export const COMPONENTS: Record<TemplateId, FC<ProductVideoProps>> = {
  "product-launch": ProductLaunch,
  "product-highlight": ProductHighlight,
  "product-sale": ProductSale,
  "product-showcase": PremiumShowcase,
  "product-story": BrandStory, // 新增
};
```

`remotion/Root.tsx` 与 `remotion/index.ts` **无需修改**：`RemotionRoot` 遍历 `TEMPLATES` 自动生成 `<Composition>`，`registerRoot` 复用同一张表，预览与渲染天然共用组件。

### Step 4 · 本地预览与逐帧验证

```bash
npm run compositions                                        # 列出 composition，确认 product-story 出现
npm run studio -- --port 3001                               # 拖时间轴逐帧看动画（与 next dev 的 3000 错开）
npx remotion still remotion/index.ts product-story output/story.png --frame=45
npx remotion render remotion/index.ts product-story output/story.mp4
```

浏览器侧还可访问 `/preview?t=product-story`：用 `@remotion/player` 低分辨率实时预览，与正式渲染共用 `COMPONENTS` 映射（`previewFor()` 返回 `sampleProps`，未注册 id 返回 `null`）。

重点看：文字是否溢出 1080×1920、图片是否变形、动画是否在 `durationInFrames` 内结束、可选字段缺省时是否留白过多。

### Step 5 · 数据库落行

**5.1 扩展分类 CHECK（仅新增分类时需要）**

新建 `db/migrations/002b_template_category.sql`（**必须排 003 之前**），幂等：

```sql
-- 放开 category 枚举以支持 product-story
BEGIN;
ALTER TABLE video_templates DROP CONSTRAINT IF EXISTS chk_templates_category;
ALTER TABLE video_templates ADD CONSTRAINT chk_templates_category
  CHECK (category IN ('launch','highlight','sale','showcase','story'));
COMMIT;
```

同步改 `prisma/schema.prisma` 的 `category` 注释（第 65 行 `/// launch / highlight / sale / showcase / story`）与 `db/migrations/001_init.sql` 第 55 行列注释（DDL 唯一真源仍是迁移脚本，禁止 `prisma migrate dev`；改完执行 `npm run prisma:generate`）。

**5.2 加种子行（保证新环境 / 测试环境有一致数据）**

改 `db/migrations/003_seed_templates.sql`，按 `composition_id` 幂等判重，UUID 固定：

```sql
('55555555-5555-4555-8555-555555555555'::uuid, 'Brand Story 品牌故事', 'story', 'product-story', 20::smallint, '{}'::jsonb, true),
```

再在 `db/migrations/005_template_admin.sql` 的**五组** `CASE composition_id` 回填里补 `product-story`（`english_name` / `description` / `cta` / `tone` / `sort_order`，建议 `sort_order=50`），并把同文件第 153 行的 `chk_templates_category` 字面量也改成 5 值（新环境只跑 001~005 时由它建约束）。**注意**：已应用过 005 的环境不会重跑回填，由下一步同步动作补元数据。

**5.3 已有环境：管理端同步**

管理员登录 `/admin/templates` → 点「从注册表同步」：

- 新增行默认 `enabled=false`；
- 补全 `displayName`（中文）与 `englishName`（英文）——两者是启用前置条件，缺一不可；
- 上传缩略图（走 `src/lib/upload.ts` 三重校验，拒 SVG，≤10MB）；
- 调整 `sortOrder` 后启用。

也可命令行 `npm run migrate` 应用种子，再走管理端补全元数据。启用后前台缓存会在 60s 内生效。

### Step 6 · 同步修改测试断言（必做，否则 `npm test` 必红）

| 文件 | 位置 | 修改内容 |
|------|------|----------|
| `tests/phase2.test.ts` | 98–107 | `compositionId` 数组加 `"product-story"`；`durationSec` 数组加 `20`；`category === id.replace("product-","")` 断言自然满足 |
| `tests/template-preview.test.ts` | 55–56 | `TEMPLATES.length` 由 `4` 改 `5`；确认新 `sampleProps` 与 `defaultProps.imageUrl` 不同 |
| `tests/phase8.test.ts` | 82–101 | `body.data.length` 由 `4` 改 `5`（种子已加行）；末尾排序断言会自动比对注册表 |
| `tests/admin-schema.test.ts` | 70–89 | 种子回填断言：`rows.length` 由 `4` 改 `5`；`composition_id` 数组加 `"product-story"`；`sort_order` 数组加 `50` |
| `tests/phase3.test.ts` | 15 / 28 / 46 / 50 | 两个 describe 标题的「4」改「5」；帧数数组 `[450,600,450,600]` 追加 `600`；组件映射循环自动覆盖新模板 |
| `scripts/ops-smoke.ts` | 143–146 | 冒烟脚本也硬编码了数量：`"返回 4 套模板"` 与 `list.length === 4` 改为 5（**实走时发现，原指南漏列**） |

`tests/ui-audit.test.ts` 实走确认**无需修改**——它只断言卡片消费 `displayFor()` / `display.englishName` / `display.cta` 等字段来源，不含模板数量硬编码（原指南将其列为「可能要改」，是误判）。

> 新增迁移脚本时，如果是**新增测试文件**而非改现有断言，必须把文件加入 `package.json` 的 `test` 脚本清单（脚本显式罗列文件，不会自动发现）。

### Step 7 · 验证与发布

按顺序执行，全绿才发版：

```bash
npm run typecheck          # TS 全量检查（component-map 漏绑会在这里暴露）
npm run lint
npm run test               # 28 个测试文件，含新增断言
npm run migrate:check      # 表 / 索引 / 约束校验
npm run prisma:validate
npm run compositions       # composition 列表含 product-story
npm run build              # 生产构建
```

冒烟清单：

1. `GET /api/templates` 返回 5 套，新模板 `compositionId` 命中注册表、排序正确；
2. `/templates` 卡片显示新模板，点击后 `/create?templateId=product-story` 可进入向导；
3. `/preview?t=product-story` 可播放；Studio 逐帧无溢出；静帧与 MP4 渲染成功；
4. 用真实商品 + AI 文案提交一个任务，Worker 渲染完成后视频可播放/下载；
5. 管理端同步不覆盖已编辑元数据；停用最后一套可渲染模板返回 409；
6. 新模板停用后 `retry` 仍可重试、`regenerate` 被明确拒绝。

---

## 5. 常见故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| TS 报错 `Property 'product-story' is missing` | `component-map.ts` 漏绑组件 | 按 Step 3 补映射 |
| `未知模板: product-story` | 未进 `TEMPLATES` 或 DB 行 `compositionId` 拼错 | 核对 `TEMPLATE_IDS` / `TEMPLATES` / 种子三处 id 完全一致 |
| 前台只有 4 张卡 | DB 行未同步或 `enabled=false` | 管理端同步 → 补全元数据 → 启用；检查 `GET /api/templates` 过滤逻辑 |
| 同步后新行仍不可启用 | `englishName` 为空 | `enableTemplate()` 要求中英文展示名都非空 |
| `TEMPLATES.length` 断言失败 | 测试未同步 | 按 Step 6 改 4 处数字/数组断言 |
| 提交任务被拒 409 | DB 行 `enabled=false` 或 `compositionId` 未注册 | 管理端启用；确认代码已发版 |
| 渲染报「不受信任的素材地址」 | 图片地址是外部 URL / `data:` 非法 MIME / 以 `/` 开头 | 走 `RenderAssetSrcSchema` + `resolveImageSrc`，用上传后的站内相对路径 |
| `npm run migrate` 报 `chk_templates_category` 冲突 | 放开 CHECK 的迁移排在 003 之后，种子先插入被拒 | 把迁移重命名为 `002b_*.sql` 排在 003 之前；不要只改代码类型 |
| `npm test` 大量 SIGABRT / 访问冲突、`Fatal process out of memory: Zone` | 并发跑 28 个文件时 PGlite WASM 内存溢出（本机实测出现） | 用 `npx tsx --test tests/<单文件>.test.ts` 逐个复跑；若 0 个 `ERR_ASSERTION` 则为环境噪声，不是回归 |
| 测试环境仍是 4 行 | 只改了代码注册，没改 `003_seed_templates.sql` | 按 Step 5.2 补种子行 |

---

## 6. 交付检查清单

- [ ] `remotion/<Name>.tsx` 组件完成，只用统一 Props 与帧驱动动画
- [ ] `TEMPLATE_IDS`、`TemplateDefinition.category`、`TEMPLATES` 三项注册完成
- [ ] `remotion/component-map.ts` 绑定完成
- [ ] 新分类的 DB CHECK 迁移（排在 003 之前，如 `002b_*.sql`）、005 约束字面量、001/Prisma 注释同步
- [ ] `003_seed_templates.sql` 种子行 + `005_template_admin.sql` 元数据回填
- [ ] 管理端同步、补全元数据、上传缩略图、启用
- [ ] Step 6 的 5 个测试文件 + `scripts/ops-smoke.ts` 断言同步（`ui-audit.test.ts` 无需改）
- [ ] `typecheck` / `lint` / `test` / `migrate:check` / `prisma:validate` / `build` 全绿
- [ ] 浏览器预览 + 静帧 + MP4 + 端到端提交任务冒烟通过

---

## 7. 实走验证记录（2026-11-27，以 `product-story` 为例）

按本文完整走一遍后，对指南做的修正与真实结论：

| 项 | 结论 |
|----|------|
| 迁移文件命名 | 原写 `006_*.sql` 是错的：003 种子先插入 story 行，被 005 遗留的 4 值 CHECK 拒绝，`npm run migrate` 直接失败。改为 `002b_template_category.sql` 后全绿 |
| `ui-audit.test.ts` | 原列为「可能要改」是误判；实测无数量硬编码，无需改动 |
| `scripts/ops-smoke.ts` | 原指南漏列；冒烟脚本有 `list.length === 4` 硬编码，必须改 |
| `tests/phase3.test.ts` | 除帧数数组外，两个标题的「4 个」也要改（原指南未点明标题行） |
| `prisma/schema.prisma` + `001_init.sql` | 两处 category 注释都要加 `story` |
| `npm test` 并发表现 | 本机并发跑 28 文件会触发 PGlite WASM `Fatal process out of memory: Zone`，产生 SIGABRT/0xC0000005 噪声；逐个文件复跑全部通过，`ERR_ASSERTION` 为 0 |

逐个复跑通过的文件：`phase2`(15/15)、`phase3`(6/6)、`template-preview`(5/5)、`phase8`(6/6)、`admin-schema`(4/4)、`migration`(1/1)、`phase9`(21/21)、`queue`(8/8)、`regenerate`(4/4)、`ui-contrast`(32/32)。`npm run typecheck` 通过；注册表与组件映射实时校验 5/5 一致。

## 8. 附：关键文件索引

| 层 | 文件 | 职责 |
|----|------|------|
| 渲染契约 | `src/shared/template.schema.ts` | `TEMPLATE_IDS` / `TEMPLATES` / `VIDEO_SPEC` / `buildVideoProps` |
| 渲染契约 | `src/shared/video-props.schema.ts` | 统一 Props 契约 `ProductVideoProps` |
| 渲染组件 | `remotion/*.tsx`、`remotion/component-map.ts`、`remotion/Root.tsx` | 组件实现、id→组件映射、Composition 注册 |
| 动画工具 | `remotion/lib/animations.ts`、`remotion/lib/image-src.ts` | 帧驱动时间函数、素材地址 fail-closed 解析 |
| 运营元数据 | `db/migrations/003_seed_templates.sql`、`005_template_admin.sql` | 种子行、展示元数据与约束 |
| 管理端 | `src/lib/admin-templates.ts`、`src/app/api/admin/templates/*` | 同步 / 编辑 / 启停 / 缩略图 / 审计 |
| 前台 | `src/app/api/templates/route.ts`、`src/app/(app)/templates/page.tsx`、`src/app/preview/page.tsx` | 列表下发、选择页、低分辨率预览 |
| 提交链路 | `src/lib/jobs.ts` | `enabled` + `getTemplate()` 双重校验、`input_json` 快照 |
| 测试 | `tests/phase2.test.ts` 等 6 个文件 | 注册表契约、预览数据、API 数量、种子回填断言 |
