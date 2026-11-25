# -*- coding: utf-8 -*-
"""把技术方案内容稿与构建脚本中的"细化版/细化/草稿"描述语改为终版口吻。"""
import io, os

BASE = r"D:/py_workspace/product-video/output/productvideo-docs"
MD = BASE + "/stage1/technical_design_detailed.md"
PY = BASE + "/build_tdd_html.py"

MD_REPL = [
    ("# ProductVideo AI 技术架构与实施方案（细化版）", "# ProductVideo AI 技术架构与实施方案"),
    (
        "本文档是《电商商品视频生成器：简化版技术架构与实施方案》的细化版。技术方向与选型完全保留草稿结论——模块化单体、Next.js 全栈、Supabase PostgreSQL、Remotion + FFmpeg 渲染、Node.js Worker 异步任务、VPS 本地磁盘存储。本次细化只做三件事：补齐**技术细节**（可直接编码的接口、DDL、协议、配置）、强化**落地性**（部署、运维、监控、备份、测试）、预留**可扩展性**（抽象层、扩展点、触发阈值与演进路径）。文中所有版本、阈值与容量数字均为建议值，需以实际压测与许可证核对结果为准。",
        "本文档是 ProductVideo AI 的技术架构与实施方案终版。技术方向与选型为——模块化单体、Next.js 全栈、Supabase PostgreSQL、Remotion + FFmpeg 渲染、Node.js Worker 异步任务、VPS 本地磁盘存储。文档覆盖三个层面：**技术细节**（可直接编码的接口、DDL、协议、配置）、**落地性**（部署、运维、监控、备份、测试）、**可扩展性**（抽象层、扩展点、触发阈值与演进路径）。文中所有版本、阈值与容量数字均为建议值，需以实际压测与许可证核对结果为准。",
    ),
    ("| 文档名称 | ProductVideo AI 技术架构与实施方案（细化版） |", "| 文档名称 | ProductVideo AI 技术架构与实施方案 |"),
    ("| 版本 | V1.1（细化版） |", "| 版本 | V1.0 |"),
    ("| 上游依据 | 简化版技术架构与实施方案草稿、PRD V1.0、用户故事与产品设计说明 |", "| 上游依据 | 产品需求文档 PRD V1.0、用户故事与产品设计说明 |"),
    ("## 2. 系统架构细化", "## 2. 系统架构"),
    ("保留草稿的六层架构，补充进程视图、运行视图与数据流，明确 Web 进程与 Worker 进程的边界。", "本章给出六层架构总览，并补充进程视图、运行视图与数据流，明确 Web 进程与 Worker 进程的边界。"),
    ("### 2.1 分层架构（保留草稿六层）", "### 2.1 分层架构"),
    ("| 层次 | 组件 | 细化职责 |", "| 层次 | 组件 | 职责 |"),
    ("草稿给出 6 张业务表的字段轮廓，本节补齐完整 DDL、约束、索引与迁移策略。SQL 中的金额为可选扩展字段，本期可暂不启用订阅相关表。", "本章给出 6 张业务表的完整 DDL、约束、索引与迁移策略。SQL 中的金额为可选扩展字段，本期可暂不启用订阅相关表。"),
    ("-- 剩余免费额度（细化：额度落到用户表）", "-- 剩余免费额度"),
    ("## 7. 视频渲染模块细化", "## 7. 视频渲染模块"),
    ("## 8. 异步任务队列细化", "## 8. 异步任务队列"),
    ("## 9. 文件存储细化", "## 9. 文件存储"),
    ("把草稿的 30 天计划细化到任务与验收命令，便于按天推进与验收。", "本章将 30 天计划拆解到任务与验收命令，便于按天推进与验收。"),
    ("| 阶段 | 时间 | 细化任务 | 验收 |", "| 阶段 | 时间 | 任务 | 验收 |"),
]

PY_REPL = [
    ("<title>ProductVideo AI 技术架构与实施方案（细化版）</title>", "<title>ProductVideo AI 技术架构与实施方案</title>"),
    ('<p class="cover-subtitle">技术架构与实施方案（细化版）</p>', '<p class="cover-subtitle">技术架构与实施方案</p>'),
    ('<p class="cover-meta">基于简化版技术架构草稿纵深细化 · 方向与原选型保持一致</p>', '<p class="cover-meta">面向研发落地与运维实施的终版技术方案</p>'),
]


def apply(path, pairs):
    with io.open(path, encoding="utf-8") as f:
        s = f.read()
    for old, new in pairs:
        n = s.count(old)
        if n != 1:
            raise SystemExit("REPLACE MISS/DUP (%d) in %s: %s" % (n, path, old[:60]))
        s = s.replace(old, new)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(s)
    print("updated", os.path.basename(path), len(pairs), "replacements")


apply(MD, MD_REPL)
apply(PY, PY_REPL)
