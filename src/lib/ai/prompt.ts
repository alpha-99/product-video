/**
 * AI 文案 Prompt 模板（方案 6.1）。
 *
 * 设计要点：
 *   1. 系统提示词固化「仅输出 JSON」「不得编造功效/认证」「字段长度上限」；
 *   2. 用户提示词只放结构化字段，不拼接自由文本，降低注入风险；
 *   3. 长度上限直接取自 COPY_LIMITS，避免提示词与 Schema 数字漂移。
 */
import { COPY_LIMITS } from "../../shared/copy.schema";
import type { AiProductInput } from "../../shared/product.schema";

/** 中文输出、JSON-only、禁编造：三条是合规底线。 */
export const SYSTEM_PROMPT = [
  "你是资深电商短视频文案编辑，为竖版短视频（9:16）撰写中文文案。",
  "只输出一个 JSON 对象，不要输出 Markdown、代码围栏、解释或任何额外文字。",
  "JSON 字段与约束：",
  `- videoTitle：字符串，${COPY_LIMITS.videoTitle} 字以内，商品标题式表达；`,
  `- subtitle：字符串，${COPY_LIMITS.subtitle} 字以内，一句补充说明；`,
  `- sellingPoints：字符串数组，1～${COPY_LIMITS.sellingPointCount} 项，每项 ${COPY_LIMITS.sellingPointLength} 字以内；`,
  `- cta：字符串，${COPY_LIMITS.cta} 字以内，行动号召。`,
  "合规要求：",
  "1. 只能基于用户提供的商品信息改写，禁止编造未提供的参数、功效、认证、销量、排名或医疗效果；",
  "2. 禁止使用「最」「第一」「国家级」「根治」「永久」等绝对化或违规用语；",
  "3. 不要输出价格以外的数字承诺，不要虚构优惠力度；",
  "4. 文案要短句化、可用于视频字幕，不使用 emoji 与特殊符号。",
].join("\n");

/** 把结构化商品信息渲染成用户消息；空字段不出现，避免模型凭空补全。 */
export function buildUserPrompt(input: AiProductInput): string {
  const lines = [`商品名称：${input.productName}`];
  if (input.description) lines.push(`商品描述：${input.description}`);
  if (input.price) lines.push(`价格：${input.price}`);
  if (input.sellingPoints?.length) {
    lines.push(`已有关键卖点：${input.sellingPoints.join("；")}`);
  }
  lines.push(
    "请输出 JSON，字段为 videoTitle、subtitle、sellingPoints、cta。"
  );
  return lines.join("\n");
}

/** 供 API / 日志引用，保证 prompt 版本变化可追踪（缓存键也带上它）。 */
export const PROMPT_VERSION = "copy-v1";
