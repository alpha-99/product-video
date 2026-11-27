/**
 * 管理后台布局：服务端 gate（FR-14 / TC-12）。
 * 普通用户直输 /admin/** URL 被服务端拦下；JWT 合法但无 users 行 → 401。
 * 状态页与原型一致，不做跳转泄露后台路径信息。
 */
import "../../admin.css";
import { checkAdminPage } from "../../../lib/admin-page";

export const dynamic = "force-dynamic";

function StatePage({ status, message }: { status: 401 | 403; message: string }) {
  const is401 = status === 401;
  return (
    <div className="admin-state">
      <div className="admin-state-card">
        <div className="admin-state-ico" aria-hidden="true">{is401 ? "◌" : "🔒"}</div>
        <h1>{is401 ? "账号未初始化" : "无访问权限"}</h1>
        <p>
          {message}
          <br />
          {is401
            ? "请联系管理员完成账号初始化后再访问管理后台。"
            : "如需权限，请联系管理员在「成员与角色」中发起提权申请，由另一名管理员复核。"}
        </p>
      </div>
    </div>
  );
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const gate = await checkAdminPage();
  if (!gate.ok) return <StatePage status={gate.status} message={gate.message} />;
  return <>{children}</>;
}
