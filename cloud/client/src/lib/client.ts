import { serviceTimezone } from '../../../shared/service-time';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export function isVersionConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === "VERSION_CONFLICT";
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const value = await response
      .json()
      .catch(() => ({ error: "Ошибка соединения" }));
    throw new ApiError(
      value.error || "Не удалось выполнить запрос",
      response.status,
      value.code,
    );
  }
  return response.json();
}
export const statuses = {
  NEW: "Новый",
  DIAGNOSTICS: "Диагностика",
  APPROVAL: "Согласование",
  IN_PROGRESS: "В работе",
  READY: "Готов",
  DELIVERED: "Выдан",
  CANCELLED: "Отменён",
};
export const conditions = {
  UNCHECKED: "Не проверялось",
  CHECKED: "Осмотрено",
  REPAIR: "Требует ремонта",
  RECOMMENDED: "Рекомендовано",
  DONE: "Выполнено",
};
export const roles = {
  ADMIN: "Администратор",
  RECEPTION: "Приёмщик",
  MASTER: "Мастер",
};
export function date(value: string) {
  return new Date(value).toLocaleDateString("ru-RU", {
    timeZone: serviceTimezone,
  });
}
export function today() {
  return new Date().toLocaleDateString("ru-RU", {
    timeZone: serviceTimezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
