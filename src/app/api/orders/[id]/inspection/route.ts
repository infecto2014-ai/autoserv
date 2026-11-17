import { withApi, json } from "@/server/http";
import { updateInspection } from "@/server/orders";
export const PUT = withApi(async (req, ctx, actor) =>
  json(await updateInspection(req, (await ctx.params).id, actor)),
);
