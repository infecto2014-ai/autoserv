import { db } from "@/server/db";
import { withApi, requireRole, fail } from "@/server/http";
export const runtime = "nodejs";
export const GET = withApi(async (req, ctx, actor) => {
  requireRole(actor, "ADMIN", "RECEPTION");
  const document = await db.document.findUnique({
    where: { id: (await ctx.params).id },
  });
  if (!document) fail(404, "Документ не найден");
  const disposition =
    new URL(req.url).searchParams.get("download") === "1"
      ? "attachment"
      : "inline";
  return new Response(new Uint8Array(document.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="document-${document.version}.pdf"; filename*=UTF-8''${encodeURIComponent(document.number)}.pdf`,
      "Content-Length": String(document.pdf.length),
      "Cache-Control": "private, no-store",
      ETag: `"${document.sha256}"`,
    },
  });
});
