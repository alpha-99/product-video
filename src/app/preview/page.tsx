import Link from "next/link";
import React from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { VideoPreviewClient } from "@/components/VideoPreviewClient";
import { TEMPLATES } from "@/shared/template.schema";
import { resolveUserId } from "@/lib/auth";

/**
 * 预览联调页：用 `?t=<templateId>` 切换模板，验证低分辨率预览与正式渲染同源。
 * 默认展示第一个模板；未知 id 静默回退，避免预览页抛错。
 * 验收 P2-06：联调页同样要求登录会话，未认证一律跳登录，不对匿名访客开放。
 */
export default function PreviewPage({
  searchParams,
}: {
  searchParams: { t?: string };
}) {
  const headerBag = new Headers();
  headers().forEach((value, key) => headerBag.set(key, value));
  let authorized = true;
  try {
    resolveUserId(headerBag);
  } catch {
    authorized = false;
  }
  if (!authorized) redirect("/login");

  const template =
    TEMPLATES.find((item) => item.id === searchParams.t) ?? TEMPLATES[0];

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: "32px 16px",
        backgroundColor: "#f6f5f2",
        fontFamily: "sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, color: "#1f2937", margin: 0 }}>
        {template.name} · 480×854 预览
      </h1>

      <nav style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {TEMPLATES.map((item) => {
          const active = item.id === template.id;
          return (
            <Link
              key={item.id}
              href={`/preview?t=${item.id}`}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 13,
                textDecoration: "none",
                border: `1px solid ${active ? "#1f2937" : "#d6d3cd"}`,
                backgroundColor: active ? "#1f2937" : "#ffffff",
                color: active ? "#ffffff" : "#4b5563",
              }}
            >
              {item.category} · {item.durationSec}s
            </Link>
          );
        })}
      </nav>

      <VideoPreviewClient
        key={template.id}
        compositionId={template.id}
        props={template.defaultProps}
      />

      <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
        规格 {template.width}×{template.height} / {template.fps}fps /{" "}
        {template.durationSec}s — 正式渲染仍为 1080×1920
      </p>
    </main>
  );
}
