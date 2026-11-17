import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db";
import type { Actor } from "@/lib/types";
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const [scheme, salt, hex] = hash.split("$");
  if (scheme !== "scrypt" || !salt || !hex || hex.length !== 128) return false;
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(key, Buffer.from(hex, "hex"));
}
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const cookieName = "sto_session";
export function sessionToken(request: Request): string | null {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
export async function sessionActor(request: Request): Promise<Actor | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: true },
  });
  if (
    !session ||
    session.expiresAt <= new Date() ||
    !session.user.active ||
    session.authVersion !== session.user.authVersion
  )
    return null;
  const { id, name, email, role } = session.user;
  return { id, name, email, role };
}
export function sessionCookie(token: string, maxAge = 43200): string {
  const secure = process.env.APP_ORIGIN?.startsWith("https://");
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export async function createSession(userId: string, authVersion: number) {
  const token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      id: hashToken(token),
      userId,
      authVersion,
      expiresAt: new Date(Date.now() + 43200_000),
    },
  });
  return token;
}
