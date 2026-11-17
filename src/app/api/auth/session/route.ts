import { json, withApi } from "@/server/http";
import { db } from "@/server/db";
export const GET = withApi(
  async (_req, _ctx, actor) => {
    const settings = actor
      ? await db.serviceSettings.findUnique({
          where: { id: "main" },
          select: { timezone: true },
        })
      : null;
    return json({
      user: actor ?? null,
      timezone: settings?.timezone ?? "Europe/Kaliningrad",
    });
  },
  { public: true },
);
