import { withApi, json } from "@/server/http";
import { loadOrder, serializeOrder, updateOrder } from "@/server/orders";
export const GET = withApi(async (_req, ctx, actor) =>
  json(serializeOrder(await loadOrder((await ctx.params).id, actor), actor)),
);
export const PATCH = withApi(async (req, ctx, actor) =>
  json(await updateOrder(req, (await ctx.params).id, actor)),
);
