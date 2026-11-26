/**
 * 进程级环境变量加载。
 *
 * Next.js 会自动读取 .env.local / .env，但通过 tsx 启动的脚本与 Worker
 * 不会。此模块在进程启动时补齐这一行为，优先级与 Next.js 一致：
 *   已有进程环境变量 > .env.<NODE_ENV>.local > .env.local(非生产) >
 *   .env.<NODE_ENV> > .env
 *
 * 阶段九：PM2 生产部署用 .env.production；这里同步支持，保证 Worker、
 * migrate、ops-check 与 Web 读到同一份配置。
 *
 * 另外对 DATABASE_URL 做一次「用户密码标准化」：不少数据库密码含
 * ? * ! + / @ 等字符，直接拼接进 URL 会让解析器把 ? 当成查询串起点，
 * 报 "invalid port number"。这里只编码裸特殊字符，已存在的 %XX 转义原样保留。
 */
import path from "node:path";
import process from "node:process";
import { config } from "dotenv";

const ROOT = process.cwd();

const nodeEnv = process.env.NODE_ENV ?? "development";
config({ path: path.join(ROOT, `.env.${nodeEnv}.local`), quiet: true });
if (nodeEnv !== "production") {
  config({ path: path.join(ROOT, ".env.local"), quiet: true });
}
config({ path: path.join(ROOT, `.env.${nodeEnv}`), quiet: true });
config({ path: path.join(ROOT, ".env"), quiet: true });

function encodePassword(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; ) {
    // 已转义的 %XX 直接保留，避免二次编码
    if (raw[i] === "%" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
      out += raw.slice(i, i + 3);
      i += 3;
      continue;
    }
    const ch = raw[i];
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      out += encodeURIComponent(ch).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      );
    }
    i += 1;
  }
  return out;
}

function normalizeDatabaseUrl(url: string): string {
  const schemeEnd = url.indexOf("://");
  const at = url.lastIndexOf("@");
  if (schemeEnd === -1 || at <= schemeEnd + 3) return url;

  const prefix = url.slice(0, schemeEnd + 3);
  const userInfo = url.slice(schemeEnd + 3, at);
  const colon = userInfo.indexOf(":");
  if (colon === -1) return url;

  const user = userInfo.slice(0, colon);
  const password = encodePassword(userInfo.slice(colon + 1));
  return `${prefix}${user}:${password}@${url.slice(at + 1)}`;
}

if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
}
