import type { OrderStatus, Role } from "./types";
export const STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: "Новый",
  DIAGNOSTICS: "Диагностика",
  APPROVAL: "Согласование",
  IN_PROGRESS: "В работе",
  READY: "Готов",
  DELIVERED: "Выдан",
  CANCELLED: "Отменён",
};
const next: Partial<Record<OrderStatus, OrderStatus>> = {
  NEW: "DIAGNOSTICS",
  DIAGNOSTICS: "APPROVAL",
  APPROVAL: "IN_PROGRESS",
  IN_PROGRESS: "READY",
  READY: "DELIVERED",
};
export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  role: Role,
): boolean {
  if (from === "DELIVERED" || from === "CANCELLED" || from === to) return false;
  if (role === "MASTER" && (to === "CANCELLED" || to === "DELIVERED"))
    return false;
  return next[from] === to || to === "CANCELLED";
}
export const isClosed = (status: OrderStatus) =>
  status === "DELIVERED" || status === "CANCELLED";
