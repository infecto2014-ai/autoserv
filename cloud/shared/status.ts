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
export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  role: Role,
): boolean {
  if (from === "DELIVERED" || from === "CANCELLED" || from === to) return false;
  if (role === "MASTER" && (to === "CANCELLED" || to === "DELIVERED"))
    return false;
  if (to === "DELIVERED") return from === "READY";
  return to !== "NEW";
}
export const isClosed = (status: OrderStatus) =>
  status === "DELIVERED" || status === "CANCELLED";
