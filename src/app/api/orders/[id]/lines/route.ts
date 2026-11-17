import { withApi, json } from "@/server/http";
import { updateLines } from "@/server/orders";
export const PUT = withApi(async (req, ctx, actor) =>
  json(await updateLines(req, (await ctx.params).id, actor)),
);
