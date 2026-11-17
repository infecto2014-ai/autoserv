import { z } from "zod";
import { db } from "@/server/db";
import { withApi, json, fail } from "@/server/http";
import { orderScope } from "@/server/access";
import { createOrder, serializeOrder } from "@/server/orders";
export const POST = withApi(async (req, _ctx, actor) =>
  json(await createOrder(req, actor), 201),
);
export const GET = withApi(async (req, _ctx, actor) => {
  const p = new URL(req.url).searchParams;
  const { page, pageSize } = z
    .object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse({
      page: p.get("page") ?? undefined,
      pageSize: p.get("pageSize") ?? undefined,
    });
  const q = (p.get("q") ?? "").slice(0, 200);
  const status = p.get("status");
  if (
    status &&
    ![
      "NEW",
      "DIAGNOSTICS",
      "APPROVAL",
      "IN_PROGRESS",
      "READY",
      "DELIVERED",
      "CANCELLED",
    ].includes(status)
  )
    fail(422, "Неизвестный статус");
  const where = {
    ...orderScope(actor),
    ...(status ? { status: status as "NEW" } : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: "insensitive" as const } },
            {
              customer: { name: { contains: q, mode: "insensitive" as const } },
            },
            {
              customer: {
                phoneNormalized: { contains: q.replace(/\D/g, "") || q },
              },
            },
            {
              vehicle: { plate: { contains: q, mode: "insensitive" as const } },
            },
            { vehicle: { vin: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const [orders, total] = await db.$transaction([
    db.workOrder.findMany({
      where,
      include: {
        customer: true,
        vehicle: true,
        master: { select: { id: true, name: true } },
        lines: true,
      },
      orderBy: { openedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.workOrder.count({ where }),
  ]);
  return json({
    items: orders.map((x) =>
      serializeOrder({ ...x, inspectionItems: [], documents: [] }, actor),
    ),
    total,
    page,
    pageSize,
  });
});
