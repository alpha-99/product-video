import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "帧片 · 汇帧成片",
  description: "AI 驱动的帧片生成平台",
};

/** 主题在首帧前落地，避免暗色主题闪白。 */
const THEME_BOOT = `try{var t=localStorage.getItem('pv-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
