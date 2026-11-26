"use client";

import { createContext, useCallback, useContext, useState } from "react";

interface Toast {
  id: number;
  text: string;
  error: boolean;
}

interface ToastApi {
  show: (text: string, error?: boolean) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const show = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, text, error }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {/* P2-7：错误项用 role="alert"（assertive），与 ErrorBanner 一致；
          成功/信息项仍为 role="status"，由容器 aria-live="polite" 播报。 */}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast${item.error ? " error" : ""}`}
            role={item.error ? "alert" : "status"}
          >
            {item.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
