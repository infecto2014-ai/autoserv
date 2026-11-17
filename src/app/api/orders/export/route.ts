import { db } from "@/server/db";
import { withApi, requireRole } from "@/server/http";
import { totalsForOrder } from "@/server/orders";
const cell = (v: unknown) =>
  '"' +
  String(v ?? "")
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""') +
  '"';
export const GET = withApi(async (_req, _ctx, actor) => {
  requireRole(actor, "ADMIN", "RECEPTION");
  const orders = await db.workOrder.findMany({
    include: { customer: true, vehicle: true, lines: true },
    orderBy: { openedAt: "desc" },
    take: 10000,
  });
  const rows = [
    [
      "Номер",
      "Дата UTC",
      "Клиент",
      "Автомобиль",
      "Статус",
      "Итого, коп.",
      "Оплачено, коп.",
    ],
    ...orders.map((x) => [
      x.number,
      x.openedAt.toISOString(),
      x.customer.name,
      `${x.vehicle.make} ${x.vehicle.model}`,
      x.status,
      totalsForOrder(x).totalCents,
      x.paidCents,
    ]),
  ];
  return new Response(
    "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n"),
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="orders.csv"',
        "Cache-Control": "no-store",
      },
    },
  );
});
