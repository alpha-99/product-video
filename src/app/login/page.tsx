"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, messageOf } from "../../lib/client/api";
import { Button, Field } from "../../components/ui";
import type { Me } from "../../lib/client/types";

/** 登录注册（设计稿 08）：开发会话签发 HttpOnly Cookie，前端不保存任何令牌。 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await api.post<Me>("/api/auth/session", { email, password });
      router.push("/");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFieldErrors(err.fields);
      // 验收 P1-07：登录接口的 401 是「邮箱或密码错误」，不应被误报成会话过期。
      setError(
        err instanceof ApiError && err.code === "UNAUTHORIZED"
          ? "邮箱或密码错误，请检查后重试"
          : messageOf(err)
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** FrameReel */
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">FR</div>
        <h1>Every frame tells a story</h1>
        <p className="lede">上传商品、选择模板，AI 帮你写好文案并生成 9:16 品牌短片。</p>

        <div className="field-mb">
          <Field
            label="邮箱"
            type="email"
            autoComplete="email"
            placeholder="you@brand.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors.email}
            required
          />
        </div>
        <div className="field-mb">
          <Field
            label="密码"
            type="password"
            autoComplete="current-password"
            placeholder="至少 8 位"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="密码至少 8 位，建议使用字母与数字组合"
            error={fieldErrors.password}
            required
            minLength={8}
          />
        </div>

        {error && (
          <div className="error-banner" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <Button type="submit" block disabled={submitting}>
          {submitting ? "登录中…" : "登录 / 注册"}
        </Button>
        <p className="muted" style={{ textAlign: "center", marginTop: 16 }}>
          新用户即获 3 次免费生成额度
        </p>
      </form>
    </div>
  );
}
