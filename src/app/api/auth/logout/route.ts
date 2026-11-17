import { json, withApi } from "@/server/http";
import { hashToken, sessionCookie, sessionToken } from "@/server/auth";
import { db } from "@/server/db";
export const POST = withApi(async (req) => {
  const token = sessionToken(req);
  if (token) await db.session.deleteMany({ where: { id: hashToken(token) } });
  const res = json({ ok: true });
  res.headers.set("Set-Cookie", sessionCookie("", 0));
  return res;
});
