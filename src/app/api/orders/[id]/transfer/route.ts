import { withApi, json } from "@/server/http";
import { transferInspection } from "@/server/orders";
export const POST = withApi(async (req, ctx, actor) =>
  json(await transferInspection(req, (await ctx.params).id, actor)),
);
