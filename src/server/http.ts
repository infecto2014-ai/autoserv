import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import type { Actor, Role } from "@/lib/types";
import { sessionActor } from "./auth";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new ApiError(status, message);
}
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export function requireRole(actor: Actor, ...roles: Role[]) {
  if (!roles.includes(actor.role)) fail(403, "Недостаточно прав");
}
export type ApiContext = { params: Promise<Record<string, string>> };
export function withApi(
  handler: (
    request: Request,
    context: ApiContext,
    actor: Actor,
  ) => Promise<Response>,
  options: { public?: boolean } = {},
) {
  return async (request: Request, context: ApiContext) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
        if (request.headers.get("origin") !== expected)
          fail(403, "Запрос с другого источника запрещён");
        const length = Number(request.headers.get("content-length") || 0);
        if (length > 1024 * 1024) fail(413, "Запрос слишком большой");
      }
      const actor = await sessionActor(request);
      if (!actor && !options.public) fail(401, "Войдите в систему");
      return await handler(request, context, actor as Actor);
    } catch (error) {
      if (error instanceof ApiError)
        return json({ error: error.message }, error.status);
      if (error instanceof ZodError)
        return json(
          {
            error: error.issues
              .map((x) => `${x.path.join(".")}: ${x.message}`)
              .join("; "),
          },
          422,
        );
      if (error instanceof SyntaxError)
        return json({ error: "Некорректный JSON" }, 400);
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002")
          return json({ error: "Такая запись уже существует" }, 409);
        if (error.code === "P2025")
          return json({ error: "Запись не найдена" }, 404);
        if (error.code === "P2003")
          return json(
            { error: "Связанная запись не найдена или используется в истории" },
            409,
          );
        if (error.code === "P2034")
          return json(
            { error: "Данные изменились. Обновите страницу и повторите" },
            409,
          );
      }
      console.error(
        "API failure",
        error instanceof Error ? error.name : "UnknownError",
      );
      return json({ error: "Ошибка сервера. Повторите запрос позднее" }, 500);
    }
  };
}
export async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Пустой запрос");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      fail(413, "Запрос слишком большой");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
