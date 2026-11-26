/** 登录后的应用外壳：侧栏 + 账户区 + 全局 Toast。登录页 /login 不在此路由组内。 */
import { AppShell } from "../../components/AppShell";
import { ToastProvider } from "../../components/Toaster";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AppShell>{children}</AppShell>
    </ToastProvider>
  );
}
