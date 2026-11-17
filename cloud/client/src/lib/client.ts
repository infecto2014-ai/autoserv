export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
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
let serviceTimezone = "Europe/Kaliningrad";
export function configureTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value }).format();
    serviceTimezone = value;
  } catch {
    /* Keep the validated default if the server returns an unsupported zone. */
  }
}
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
