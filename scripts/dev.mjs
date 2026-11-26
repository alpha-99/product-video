#!/usr/bin/env node
/**
 * 跨平台启动 Next.js dev，并把构建缓存隔离到独立目录。
 *
 *   npm run dev:isolated                    # 默认 3000 端口 + .next-dev
 *   PORT=3001 npm run dev:isolated         # 改端口
 *   NEXT_DIST_DIR=.next-alt npm run dev:isolated
 *
 * 背景：Bash 的 `VAR=value command` 行内赋值语法在 PowerShell / CMD 中
 * 不合法，而 npm 在 Windows 上又是通过 cmd.exe 执行 scripts 的。
 * 这里直接由 Node 设置子进程 env 并调用 next 的 bin 文件，
 * 不引入 cross-env 之类的新依赖，Windows / macOS / Linux 行为一致。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const port = process.env.PORT || "3000";
const distDir = process.env.NEXT_DIST_DIR || ".next-dev";
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

if (!existsSync(nextBin)) {
  console.error("[dev] 未找到 node_modules/next/dist/bin/next，请先运行 npm install");
  process.exit(1);
}

// --dry-run：只打印将执行的命令与环境变量，不启动服务（用于核对/排障）。
if (process.argv.includes("--dry-run")) {
  console.log(`[dev] dry-run: ${process.execPath} ${nextBin} dev -p ${port}`);
  console.log(`[dev] env NEXT_DIST_DIR=${distDir}`);
  process.exit(0);
}

console.log(`[dev] port=${port} distDir=${distDir}  (Ctrl+C 退出)`);

const child = spawn(process.execPath, [nextBin, "dev", "-p", port], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: distDir },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error(`[dev] 启动失败：${error.message}`);
  process.exit(1);
});
