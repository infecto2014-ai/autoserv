import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/server/db";
import { body, fail, json, withApi } from "@/server/http";
import {
  createSession,
  sessionCookie,
  verifyPassword,
  hashPassword,
} from "@/server/auth";
const schema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((x) => x.toLowerCase()),
    password: z.string().min(1).max(256),
  })
  .strict();
const dummyHash = hashPassword(randomBytes(32).toString("hex"));
export const POST = withApi(
  async (req) => {
    const input = schema.parse(await body(req));
    const throttleKey = createHash("sha256").update(input.email).digest("hex");
    const allowed = await db.$transaction(async (tx) => {
      await tx.loginThrottle.upsert({
        where: { id: throttleKey },
        create: {
          id: throttleKey,
          resetAt: new Date(Date.now() + 15 * 60_000),
        },
        update: {},
      });
      await tx.$queryRaw`SELECT id FROM "LoginThrottle" WHERE id=${throttleKey} FOR UPDATE`;
      const record = await tx.loginThrottle.findUniqueOrThrow({
        where: { id: throttleKey },
      });
      const expired = record.resetAt <= new Date();
      if (!expired && record.attempts >= 10) return false;
      await tx.loginThrottle.update({
        where: { id: throttleKey },
        data: expired
          ? { attempts: 1, resetAt: new Date(Date.now() + 15 * 60_000) }
          : { attempts: { increment: 1 } },
      });
      return true;
    });
    if (!allowed)
      fail(429, "Слишком много попыток входа. Повторите через 15 минут");
    const user = await db.user.findUnique({ where: { email: input.email } });
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await dummyHash),
    );
    if (!user || !user.active || !valid) fail(401, "Неверный email или пароль");
    const token = await createSession(user.id, user.authVersion);
    await db.loginThrottle.deleteMany({ where: { id: throttleKey } });
    await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const settings = await db.serviceSettings.findUnique({
      where: { id: "main" },
      select: { timezone: true },
    });
    const res = json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      timezone: settings?.timezone ?? "Europe/Kaliningrad",
    });
    res.headers.set("Set-Cookie", sessionCookie(token));
    return res;
  },
  { public: true },
);
