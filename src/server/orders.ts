import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/types";
import { calculateTotals, MAX_MONEY, MAX_QUANTITY } from "@/lib/money";
import { canTransition, isClosed } from "@/lib/status";
import { db } from "./db";
import { body, fail } from "./http";
import { orderScope } from "./access";
export const cents = z.number().int().min(0).max(MAX_MONEY);
export const quantity = z.number().int().min(1).max(MAX_QUANTITY);
export const versionField = z.number().int().min(0);
export const orderInclude = {
  customer: true,
  vehicle: true,
  master: { select: { id: true, name: true } },
  inspectionItems: { orderBy: [{ category: "asc" }, { id: "asc" }] },
  lines: { orderBy: { id: "asc" } },
  documents: {
    select: {
      id: true,
      number: true,
      kind: true,
      version: true,
      createdAt: true,
      sha256: true,
    },
    orderBy: { createdAt: "desc" },
  },
} satisfies Prisma.WorkOrderInclude;
export type FullOrder = Prisma.WorkOrderGetPayload<{
  include: typeof orderInclude;
}>;
export function totalsForOrder(order: {
  lines: {
    kind: "LABOR" | "PART";
    quantityMilli: number;
    unitPriceCents: number;
  }[];
  discountCents: number;
  paidCents: number;
}) {
  try {
    return calculateTotals(order.lines, order.discountCents, order.paidCents);
  } catch (error) {
    fail(422, error instanceof Error ? error.message : "Ошибка расчёта");
  }
}
export function serializeOrder(order: FullOrder, actor?: Actor) {
  if (actor?.role === "MASTER") {
    // Мастер видит результат диагностики и объём назначенных работ, финансовые данные не выдаются.
    return {
      ...order,
      vehicle: { ...order.vehicle, customerId: "", comment: "" },
      discountCents: 0,
      paidCents: 0,
      lines: order.lines.map((x) => ({ ...x, unitPriceCents: 0 })),
      inspectionItems: order.inspectionItems.map((x) => ({
        ...x,
        laborPriceCents: 0,
        originalPriceCents: 0,
        analogPriceCents: 0,
        customPriceCents: 0,
      })),
      documents: [],
      totals: calculateTotals([]),
    };
  }
  return { ...order, totals: totalsForOrder(order) };
}
export async function loadOrder(
  id: string,
  actor: Actor,
  tx: Prisma.TransactionClient = db,
) {
  const order = await tx.workOrder.findFirst({
    where: { id, ...orderScope(actor) },
    include: orderInclude,
  });
  if (!order) fail(404, "Заказ не найден");
  return order;
}
export async function lockOrder(
  tx: Prisma.TransactionClient,
  id: string,
  actor: Actor,
  version: number,
  allowClosed = false,
) {
  const changed = await tx.workOrder.updateMany({
    where: { id, version, ...orderScope(actor) },
    data: { version: { increment: 1 } },
  });
  if (!changed.count) {
    await loadOrder(id, actor, tx);
    fail(409, "Заказ изменён другим сотрудником. Обновите данные");
  }
  const order = await loadOrder(id, actor, tx);
  if (!allowClosed && isClosed(order.status))
    fail(409, "Выданный или отменённый заказ нельзя изменять");
  return order;
}
export async function nextNumber(
  tx: Prisma.TransactionClient,
  namespace: string,
  prefix: string,
) {
  const year = new Date().getUTCFullYear();
  const sequence = await tx.sequence.upsert({
    where: { id: `${namespace}-${year}` },
    create: { id: `${namespace}-${year}`, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${year}-${String(sequence.value).padStart(6, "0")}`;
}
export async function audit(
  tx: Prisma.TransactionClient,
  actor: Actor,
  action: string,
  entityId: string,
  data: Prisma.InputJsonValue = {},
) {
  await tx.auditEvent.create({
    data: {
      actorId: actor.id,
      action,
      entityType: "WorkOrder",
      entityId,
      data,
    },
  });
}
const createSchema = z
  .object({
    vehicleId: z.string().min(1),
    masterId: z.string().nullable().optional(),
    mileage: z.number().int().min(0).max(10000000),
    complaint: z.string().trim().min(1).max(5000),
  })
  .strict();
export async function createOrder(request: Request, actor: Actor) {
  if (actor.role === "MASTER") fail(403, "Создавать заказы может приёмщик");
  const input = createSchema.parse(await body(request));
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id=${input.vehicleId} FOR UPDATE`;
    const vehicle = await tx.vehicle.findFirst({
      where: {
        id: input.vehicleId,
        archivedAt: null,
        customer: { archivedAt: null },
      },
      include: { customer: true },
    });
    if (!vehicle) fail(404, "Активный автомобиль не найден");
    if (input.mileage < vehicle.mileage)
      fail(422, "Пробег не может быть меньше последнего зафиксированного");
    if (
      input.masterId &&
      !(await tx.user.findFirst({
        where: { id: input.masterId, role: "MASTER", active: true },
      }))
    )
      fail(422, "Выберите активного мастера");
    const catalog = await tx.catalogItem.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    });
    const number = await nextNumber(tx, "order", "ЗН");
    const order = await tx.workOrder.create({
      data: {
        number,
        vehicleId: vehicle.id,
        customerId: vehicle.customerId,
        masterId: input.masterId ?? null,
        mileage: input.mileage,
        complaint: input.complaint,
        inspectionItems: {
          create: catalog.map((x) => ({
            catalogItemId: x.id,
            category: x.category,
            name: x.name,
            laborPriceCents: x.laborPriceCents,
            authorId: actor.id,
          })),
        },
      },
      include: orderInclude,
    });
    await tx.vehicle.update({
      where: { id: vehicle.id },
      data: { mileage: input.mileage },
    });
    await audit(tx, actor, "ORDER_CREATED", order.id, { number });
    return serializeOrder(order, actor);
  });
}
const updateSchema = z
  .object({
    version: versionField,
    status: z
      .enum([
        "NEW",
        "DIAGNOSTICS",
        "APPROVAL",
        "IN_PROGRESS",
        "READY",
        "DELIVERED",
        "CANCELLED",
      ])
      .optional(),
    masterId: z.string().nullable().optional(),
    complaint: z.string().trim().min(1).max(5000).optional(),
    comment: z.string().max(5000).optional(),
    recommendations: z.string().max(10000).optional(),
    discountCents: cents.optional(),
    paidCents: cents.optional(),
  })
  .strict();
export async function updateOrder(request: Request, id: string, actor: Actor) {
  const { version, ...data } = updateSchema.parse(await body(request));
  if (
    actor.role === "MASTER" &&
    Object.keys(data).some(
      (k) => !["status", "comment", "recommendations"].includes(k),
    )
  )
    fail(403, "Мастер не может изменять реквизиты и цены заказа");
  return db.$transaction(async (tx) => {
    const order = await lockOrder(tx, id, actor, version);
    if (data.status && !canTransition(order.status, data.status, actor.role))
      fail(422, "Недопустимый переход статуса");
    if (
      data.masterId &&
      !(await tx.user.findFirst({
        where: { id: data.masterId, active: true, role: "MASTER" },
      }))
    )
      fail(422, "Выберите активного мастера");
    const totals = totalsForOrder({
      ...order,
      discountCents: data.discountCents ?? order.discountCents,
      paidCents: data.paidCents ?? order.paidCents,
    });
    if (data.status === "DELIVERED" && totals.balanceCents !== 0)
      fail(422, "Перед выдачей отметьте полную оплату");
    if (data.status === "CANCELLED" && totals.paidCents > 0)
      fail(422, "Отмена оплаченного заказа требует урегулирования оплаты");
    await tx.workOrder.update({
      where: { id },
      data: {
        ...data,
        ...(data.status && isClosed(data.status)
          ? { closedAt: new Date() }
          : {}),
      },
    });
    await audit(tx, actor, "ORDER_UPDATED", id, {
      before: {
        status: order.status,
        discountCents: order.discountCents,
        paidCents: order.paidCents,
        masterId: order.masterId,
      },
      after: data,
    });
    return serializeOrder(await loadOrder(id, actor, tx), actor);
  });
}
export const inspectionSchema = z
  .object({
    version: versionField,
    recommendations: z.string().max(10000).optional(),
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          catalogItemId: z.string().nullable().optional(),
          category: z.string().trim().min(1).max(120),
          name: z.string().trim().min(1).max(500),
          left: z.boolean(),
          right: z.boolean(),
          condition: z.enum([
            "UNCHECKED",
            "CHECKED",
            "REPAIR",
            "RECOMMENDED",
            "DONE",
          ]),
          quantityMilli: quantity,
          laborPriceCents: cents,
          originalPriceCents: cents,
          analogPriceCents: cents,
          customPriceCents: cents,
          selectedPart: z.enum(["NONE", "ORIGINAL", "ANALOG", "CUSTOM"]),
          note: z.string().max(3000),
        }),
      )
      .max(300),
  })
  .strict();
export async function updateInspection(
  request: Request,
  id: string,
  actor: Actor,
) {
  const input = inspectionSchema.parse(await body(request));
  return db.$transaction(
    async (tx) => {
      const order = await lockOrder(tx, id, actor, input.version);
      const existing = new Map(order.inspectionItems.map((x) => [x.id, x]));
      if (
        input.items.length !== existing.size ||
        new Set(input.items.map((x) => x.id)).size !== existing.size
      )
        fail(422, "Состав осмотра не совпадает с заказом");
      for (const item of input.items) {
        const old = existing.get(item.id);
        if (!old) fail(422, "Позиция не принадлежит заказу");
        const { id: itemId, catalogItemId: ignoredCatalog, ...data } = item;
        void ignoredCatalog;
        if (actor.role === "MASTER") {
          if (
            ["category", "name", "quantityMilli", "selectedPart"].some(
              (k) =>
                item[k as keyof typeof item] !== old[k as keyof typeof old],
            )
          )
            fail(403, "Мастер не может изменять состав и количество");
          const priceKeys = [
            "laborPriceCents",
            "originalPriceCents",
            "analogPriceCents",
            "customPriceCents",
          ] as const;
          // UI мастера получает нули вместо цен, принимать только нули или неизменённые значения.
          if (priceKeys.some((k) => item[k] !== 0 && item[k] !== old[k]))
            fail(403, "Мастер не может изменять цены");
          await tx.inspectionItem.update({
            where: { id: itemId },
            data: {
              left: item.left,
              right: item.right,
              condition: item.condition,
              note: item.note,
              authorId: actor.id,
            },
          });
        } else {
          // Цены перенесённых строк изменяются отдельно и явно; существующие документы неизменяемы.
          await tx.inspectionItem.update({
            where: { id: itemId },
            data: { ...data, authorId: actor.id },
          });
        }
      }
      if (input.recommendations !== undefined)
        await tx.workOrder.update({
          where: { id },
          data: { recommendations: input.recommendations },
        });
      await audit(tx, actor, "INSPECTION_SAVED", id, {
        before: order.inspectionItems.map((x) => ({
          id: x.id,
          condition: x.condition,
          left: x.left,
          right: x.right,
          quantityMilli: x.quantityMilli,
          laborPriceCents: x.laborPriceCents,
          originalPriceCents: x.originalPriceCents,
          analogPriceCents: x.analogPriceCents,
          customPriceCents: x.customPriceCents,
          selectedPart: x.selectedPart,
          note: x.note,
        })),
        after: input.items.map((x) => ({
          id: x.id,
          condition: x.condition,
          left: x.left,
          right: x.right,
          quantityMilli: x.quantityMilli,
          ...(actor.role === "MASTER"
            ? {}
            : {
                laborPriceCents: x.laborPriceCents,
                originalPriceCents: x.originalPriceCents,
                analogPriceCents: x.analogPriceCents,
                customPriceCents: x.customPriceCents,
                selectedPart: x.selectedPart,
              }),
          note: x.note,
        })),
        recommendations: input.recommendations ?? order.recommendations,
      });
      return serializeOrder(await loadOrder(id, actor, tx), actor);
    },
    { timeout: 20000 },
  );
}
const transferSchema = z
  .object({
    version: versionField,
    inspectionItemIds: z.array(z.string()).min(1).max(300),
  })
  .strict();
export async function transferInspection(
  request: Request,
  id: string,
  actor: Actor,
) {
  if (actor.role === "MASTER") fail(403, "Переносить цены может приёмщик");
  const input = transferSchema.parse(await body(request));
  return db.$transaction(async (tx) => {
    const order = await lockOrder(tx, id, actor, input.version);
    for (const itemId of new Set(input.inspectionItemIds)) {
      const item = order.inspectionItems.find((x) => x.id === itemId);
      if (!item) fail(422, "Позиция не принадлежит заказу");
      const base = {
        orderId: id,
        inspectionItemId: item.id,
        name: item.name,
        quantityMilli: item.quantityMilli,
      };
      const labor = {
        ...base,
        kind: "LABOR" as const,
        unitPriceCents: item.laborPriceCents,
        variant: "NONE" as const,
      };
      await tx.orderLine.upsert({
        where: {
          orderId_inspectionItemId_kind: {
            orderId: id,
            inspectionItemId: item.id,
            kind: "LABOR",
          },
        },
        create: labor,
        update: labor,
      });
      if (item.selectedPart !== "NONE") {
        const price =
          item.selectedPart === "ORIGINAL"
            ? item.originalPriceCents
            : item.selectedPart === "ANALOG"
              ? item.analogPriceCents
              : item.customPriceCents;
        const part = {
          ...base,
          kind: "PART" as const,
          unitPriceCents: price,
          variant: item.selectedPart,
        };
        await tx.orderLine.upsert({
          where: {
            orderId_inspectionItemId_kind: {
              orderId: id,
              inspectionItemId: item.id,
              kind: "PART",
            },
          },
          create: part,
          update: part,
        });
      } else
        await tx.orderLine.deleteMany({
          where: { orderId: id, inspectionItemId: item.id, kind: "PART" },
        });
    }
    const result = await loadOrder(id, actor, tx);
    totalsForOrder(result);
    await audit(tx, actor, "INSPECTION_TRANSFERRED", id, {
      inspectionItemIds: input.inspectionItemIds,
      before: order.lines.map((x) => ({
        id: x.id,
        kind: x.kind,
        name: x.name,
        quantityMilli: x.quantityMilli,
        unitPriceCents: x.unitPriceCents,
        variant: x.variant,
      })),
      after: result.lines.map((x) => ({
        id: x.id,
        kind: x.kind,
        name: x.name,
        quantityMilli: x.quantityMilli,
        unitPriceCents: x.unitPriceCents,
        variant: x.variant,
      })),
    });
    return serializeOrder(result, actor);
  });
}
const linesSchema = z
  .object({
    version: versionField,
    lines: z
      .array(
        z.object({
          id: z.string().optional(),
          kind: z.enum(["LABOR", "PART"]),
          name: z.string().trim().min(1).max(500),
          quantityMilli: quantity,
          unitPriceCents: cents,
          variant: z
            .enum(["NONE", "ORIGINAL", "ANALOG", "CUSTOM"])
            .default("NONE"),
          article: z.string().max(120).default(""),
        }),
      )
      .max(300),
  })
  .strict();
export async function updateLines(request: Request, id: string, actor: Actor) {
  if (actor.role === "MASTER")
    fail(403, "Изменять работы и цены может приёмщик");
  const input = linesSchema.parse(await body(request));
  return db.$transaction(async (tx) => {
    const order = await lockOrder(tx, id, actor, input.version);
    totalsForOrder({ ...order, lines: input.lines });
    const ids = input.lines.map((x) => x.id).filter((x): x is string => !!x);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((x) => !order.lines.some((y) => y.id === x))
    )
      fail(422, "Некорректные идентификаторы строк");
    await tx.orderLine.deleteMany({
      where: { orderId: id, id: { notIn: ids } },
    });
    for (const { id: lineId, ...data } of input.lines) {
      if (data.kind === "LABOR" && data.variant !== "NONE")
        fail(422, "Работа не может иметь вариант запчасти");
      if (lineId) await tx.orderLine.update({ where: { id: lineId }, data });
      else await tx.orderLine.create({ data: { ...data, orderId: id } });
    }
    await audit(tx, actor, "LINES_UPDATED", id, {
      before: order.lines.map((x) => ({
        id: x.id,
        kind: x.kind,
        name: x.name,
        quantityMilli: x.quantityMilli,
        unitPriceCents: x.unitPriceCents,
        variant: x.variant,
      })),
      after: input.lines,
    });
    return serializeOrder(await loadOrder(id, actor, tx), actor);
  });
}
