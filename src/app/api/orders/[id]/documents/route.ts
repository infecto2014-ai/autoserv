import { withApi, json } from "@/server/http";
import { createDocument } from "@/server/documents";
export const runtime = "nodejs";
export const POST = withApi(async (req, ctx, actor) =>
  json(await createDocument(req, (await ctx.params).id, actor), 201),
);
