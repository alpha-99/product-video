/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Windows 上 .next/trace 偶发文件锁（EPERM），关闭 SWC trace 写入。
  experimental: {
    swcTraceProfiling: false,
  },
};

export default nextConfig;
