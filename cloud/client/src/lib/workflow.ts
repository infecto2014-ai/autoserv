import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./client";

/** A response can be lost after commit. Retry the exact same version and payload. */
export function useRetryableWrite<T>() {
  const attempt = useRef<{ path: string; body: Record<string, unknown> } | null>(null);
  const running = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  async function send(path: string, body: Record<string, unknown>): Promise<T> {
    if (running.current) throw new Error("Запрос уже выполняется.");
    running.current = true;
    attempt.current ??= { path, body: { ...body, requestId: crypto.randomUUID() } };
    try {
      const result = await api<T>(attempt.current.path, "POST", attempt.current.body);
      attempt.current = null;
      setUncertain(false);
      return result;
    } catch (error) {
      const definitive = error instanceof ApiError && error.status < 500;
      if (definitive && error.code !== "IDEMPOTENCY_MISMATCH") attempt.current = null;
      setUncertain(!definitive);
      throw error;
    } finally {
      running.current = false;
    }
  }
  return { send, uncertain };
}

export function useDraftGuard(active: boolean, notify: (message: string) => void) {
  useEffect(() => {
    if (!active) return;
    const originalHash = location.hash;
    function before(e: BeforeUnloadEvent) { e.preventDefault(); }
    function navigate(e: MouseEvent) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element).closest('a[href^="#"]');
      if (!anchor || anchor.getAttribute("href") === location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      notify("Сохраните или отмените изменения перед переходом.");
    }
    function onHistory() {
      if (location.hash === originalHash) return;
      history.replaceState(null, "", originalHash || location.pathname);
      notify("Сохраните или отмените изменения перед переходом.");
    }
    window.addEventListener("beforeunload", before);
    window.addEventListener("hashchange", onHistory, true);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("hashchange", onHistory, true);
      document.removeEventListener("click", navigate, true);
    };
  }, [active, notify]);
}
