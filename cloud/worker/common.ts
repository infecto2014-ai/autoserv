import type { Actor, Role } from './types';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: 'VERSION_CONFLICT' | 'IDEMPOTENCY_MISMATCH') { super(message); this.name = 'HttpError'; }
}
export function fail(status: number, message: string): never { throw new HttpError(status, message); }
export function versionConflict(): never {
  throw new HttpError(409, 'Данные изменились. Загрузите актуальную версию.', 'VERSION_CONFLICT');
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
/** Stream and count bytes before parsing, including when Content-Length is absent. */
export async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  const maxBytes = 1024 * 1024;
  if (Number(request.headers.get('content-length')) > maxBytes) fail(413, 'Слишком большой запрос');
  if (!request.body) fail(400, 'Требуется JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); fail(413, 'Слишком большой запрос'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Требуется JSON-объект');
    return parsed as T;
  } catch (error) { if (error instanceof HttpError) throw error; fail(400, 'Некорректный JSON'); }
}
export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) fail(403, 'Недостаточно прав');
}
export function pagination(request: Request): { q: string; page: number; pageSize: number } {
  const params = new URL(request.url).searchParams;
  const positive = (value: string | null, fallback: number, maximum: number) => {
    if (value === null) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail(400, 'Некорректная пагинация');
    return number;
  };
  return { q: (params.get('q') ?? '').trim().slice(0, 200), page: positive(params.get('page'), 1, 1000000), pageSize: positive(params.get('pageSize'), 25, 100) };
}
