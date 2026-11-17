import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/types";
import { db } from "./db";
import { body, fail, json, requireRole, withApi } from "./http";
import { customerScope, vehicleScope, orderScope } from "./access";
import { hashPassword } from "./auth";
import { calculateTotals } from "@/lib/money";

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => text(max).min(1);
const id = required(100);
const money = z.number().int().min(0).max(1_000_000_000);
const phone = required(50).refine(
  (v) => v.replace(/\D/g, "").length >= 5,
  "Укажите корректный телефон",
);
const email = z
  .union([z.email().max(254), z.literal(""), z.null()])
  .transform((v) => v || null);
export const customerCreate = z.strictObject({
  kind: z.enum(["PERSON", "COMPANY"]),
  name: required(200),
  phone,
  email: email.optional(),
  comment: text(10000).optional(),
});
export const customerPatch = customerCreate
  .omit({ kind: true })
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "Нет изменений");
export const vehicleCreate = z.strictObject({
  customerId: id,
  make: required(100),
  model: required(100),
  year: z
    .number()
    .int()
    .min(1886)
    .max(new Date().getUTCFullYear() + 1)
    .nullable()
    .optional(),
  vin: z
    .union([
      text(17).regex(/^[A-HJ-NPR-Z0-9]{5,17}$/i, "Некорректный VIN"),
      z.literal(""),
      z.null(),
    ])
    .transform((v) => v?.toUpperCase() || null)
    .optional(),
  plate: text(30).nullable().optional(),
  mileage: z.number().int().min(0).max(10000000),
  engine: text(300).optional(),
  comment: text(10000).optional(),
});
export const vehiclePatch = vehicleCreate
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "Нет изменений");
const role = z.enum(["ADMIN", "RECEPTION", "MASTER"]);
const password = z.string().min(12).max(128);
export const staffCreate = z.strictObject({
  name: required(200),
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password,
  role,
});
export const staffPatch = z
  .strictObject({
    name: required(200).optional(),
    role: role.optional(),
    active: z.boolean().optional(),
    password: password.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Нет изменений");
export const catalogCreate = z.strictObject({
  category: required(100),
  name: required(200),
  unit: required(30).optional(),
  laborPriceCents: money.optional(),
  sortOrder: z.number().int().min(0).max(1000000).optional(),
});
export const catalogPatch = catalogCreate
  .partial()
  .extend({ active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "Нет изменений");
export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value === "UTC" || value.includes("/");
  } catch {
    return false;
  }
}
export const settingsPatch = z
  .strictObject({
    name: required(200).optional(),
    address: text(1000).optional(),
    phone: text(50).optional(),
    taxId: text(30).optional(),
    timezone: required(100)
      .refine(validTimezone, "Укажите IANA часовой пояс")
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Нет изменений");
export function pagination(request: Request) {
  const p = new URL(request.url).searchParams;
  return z
    .strictObject({
      q: text(200),
      page: z.coerce.number().int().min(1).max(1000000),
      pageSize: z.coerce.number().int().min(1).max(100),
    })
    .parse({
      q: p.get("q") ?? "",
      page: p.get("page") ?? 1,
      pageSize: p.get("pageSize") ?? 25,
    });
}
const staffSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
} as const;
const serial = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
};
const historyInclude = {
  lines: true,
  customer: true,
  vehicle: true,
  master: { select: { id: true, name: true } },
} as const;
type HistoryCustomer = {
  id: string;
  kind: string;
  name: string;
  archivedAt: Date | null;
};
function customerForActor<T extends HistoryCustomer>(
  customer: T,
  actor: Actor,
) {
  return actor.role === "MASTER"
    ? {
        id: customer.id,
        kind: customer.kind,
        name: customer.name,
        phone: "",
        email: null,
        comment: "",
        archivedAt: customer.archivedAt,
      }
    : customer;
}
function historyTotals<
  T extends {
    customer: HistoryCustomer;
    vehicle: { customerId: string };
    lines: {
      kind: "LABOR" | "PART";
      quantityMilli: number;
      unitPriceCents: number;
    }[];
    discountCents: number;
    paidCents: number;
  },
>(orders: T[], actor: Actor) {
  return orders.map((order) =>
    actor.role === "MASTER"
      ? {
          ...order,
          customer: customerForActor(order.customer, actor),
          vehicle: { ...order.vehicle, customerId: "", comment: "" },
          discountCents: 0,
          paidCents: 0,
          lines: order.lines.map((line) => ({ ...line, unitPriceCents: 0 })),
          documents: [],
          totals: calculateTotals([]),
        }
      : {
          ...order,
          totals: calculateTotals(
            order.lines,
            order.discountCents,
            order.paidCents,
          ),
        },
  );
}
function audit(
  tx: Prisma.TransactionClient,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  data: Prisma.InputJsonValue,
) {
  return tx.auditEvent.create({
    data: { actorId, action, entityType, entityId, data },
  });
}

export const customersGET = withApi(async (req, _ctx, actor) => {
  const { q, page, pageSize } = pagination(req);
  const digits = q.replace(/\D/g, "");
  const where: Prisma.CustomerWhereInput = {
    AND: [
      customerScope(actor),
      ...(q
        ? [
            {
              OR: [
                { name: { contains: q, mode: "insensitive" as const } },
                { phone: { contains: q } },
                ...(digits ? [{ phoneNormalized: { contains: digits } }] : []),
                { email: { contains: q, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  };
  const [items, total] = await db.$transaction([
    db.customer.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    db.customer.count({ where }),
  ]);
  return json({ items, total, page, pageSize });
});
export const customersPOST = withApi(async (req, _ctx, actor) => {
  requireRole(actor, "ADMIN", "RECEPTION");
  const input = customerCreate.parse(await body(req));
  const result = await db.$transaction(async (tx) => {
    const value = await tx.customer.create({
      data: { ...input, phoneNormalized: input.phone.replace(/\D/g, "") },
    });
    await audit(tx, actor.id, "CREATE", "Customer", value.id, {
      fields: Object.keys(input),
    });
    return value;
  });
  return json(result, 201);
});
export const customerGET = withApi(async (_req, ctx, actor) => {
  const { id } = await ctx.params;
  const value = await db.customer.findFirst({
    where: { AND: [{ id }, customerScope(actor)] },
    include: {
      vehicles: { where: vehicleScope(actor) },
      orders: {
        where: orderScope(actor),
        include: historyInclude,
        orderBy: { openedAt: "desc" },
      },
    },
  });
  if (!value) fail(404, "Клиент не найден");
  return json({ ...value, orders: historyTotals(value.orders, actor) });
});
export const customerPATCH = withApi(async (req, ctx, actor) => {
  requireRole(actor, "ADMIN", "RECEPTION");
  const { id } = await ctx.params;
  const { archived, ...input } = customerPatch.parse(await body(req));
  const result = await db.$transaction(async (tx) => {
    const value = await tx.customer.update({
      where: { id },
      data: {
        ...input,
        ...(input.phone
          ? { phoneNormalized: input.phone.replace(/\D/g, "") }
          : {}),
        ...(archived === undefined
          ? {}
          : { archivedAt: archived ? new Date() : null }),
      },
    });
    await audit(
      tx,
      actor.id,
      archived === undefined ? "UPDATE" : archived ? "ARCHIVE" : "RESTORE",
      "Customer",
      id,
      {
        fields: [
          ...Object.keys(input),
          ...(archived === undefined ? [] : ["archived"]),
        ],
      },
    );
    return value;
  });
  return json(result);
});

export const vehiclesGET = withApi(async (req, _ctx, actor) => {
  const { q, page, pageSize } = pagination(req);
  const where: Prisma.VehicleWhereInput = {
    AND: [
      vehicleScope(actor),
      ...(q
        ? [
            {
              OR: [
                { make: { contains: q, mode: "insensitive" as const } },
                { model: { contains: q, mode: "insensitive" as const } },
                { vin: { contains: q, mode: "insensitive" as const } },
                { plate: { contains: q, mode: "insensitive" as const } },
                {
                  customer: {
                    AND: [
                      customerScope(actor),
                      { name: { contains: q, mode: "insensitive" as const } },
                    ],
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
  const [items, total] = await db.$transaction([
    db.vehicle.findMany({
      where,
      include: { customer: true },
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    }),
    db.vehicle.count({ where }),
  ]);
  const allowedOwners =
    actor.role === "MASTER"
      ? new Set(
          (
            await db.customer.findMany({
              where: {
                AND: [
                  {
                    id: {
                      in: [
                        ...new Set(items.map((vehicle) => vehicle.customerId)),
                      ],
                    },
                  },
                  customerScope(actor),
                ],
              },
              select: { id: true },
            })
          ).map((customer) => customer.id),
        )
      : null;
  return json({
    items: items.map((vehicle) =>
      allowedOwners && !allowedOwners.has(vehicle.customerId)
        ? { ...vehicle, customerId: "", customer: null, comment: "" }
        : {
            ...vehicle,
            customer: customerForActor(vehicle.customer, actor),
            ...(actor.role === "MASTER" ? { comment: "" } : {}),
          },
    ),
    total,
    page,
    pageSize,
  });
});
export const vehiclesPOST = withApi(async (req, _ctx, actor) => {
  requireRole(actor, "ADMIN", "RECEPTION");
  const input = vehicleCreate.parse(await body(req));
  const result = await db.$transaction(async (tx) => {
    if (
      !(await tx.customer.findFirst({
        where: { id: input.customerId, archivedAt: null },
        select: { id: true },
      }))
    )
      fail(422, "Выберите активного клиента");
    const value = await tx.vehicle.create({
      data: {
        ...input,
        ownerships: { create: { customerId: input.customerId } },
      },
    });
    await audit(tx, actor.id, "CREATE", "Vehicle", value.id, {
      customerId: input.customerId,
    });
    return value;
  }, serial);
  return json(result, 201);
});
export const vehicleGET = withApi(async (_req, ctx, actor) => {
  const { id } = await ctx.params;
  const value = await db.vehicle.findFirst({
    where: { AND: [{ id }, vehicleScope(actor)] },
    include: {
      customer: true,
      orders: {
        where: orderScope(actor),
        include: historyInclude,
        orderBy: { openedAt: "desc" },
      },
      ownerships: {
        where:
          actor.role === "MASTER" ? { customer: customerScope(actor) } : {},
        include: { customer: true },
        orderBy: { startedAt: "desc" },
      },
    },
  });
  if (!value) fail(404, "Автомобиль не найден");
  const ownerAllowed =
    actor.role !== "MASTER" ||
    !!(await db.customer.findFirst({
      where: { AND: [{ id: value.customerId }, customerScope(actor)] },
      select: { id: true },
    }));
  return json({
    ...value,
    ...(actor.role === "MASTER" ? { comment: "" } : {}),
    customerId: ownerAllowed ? value.customerId : "",
    customer: ownerAllowed ? customerForActor(value.customer, actor) : null,
    ownerships: value.ownerships.map((ownership) => ({
      ...ownership,
      customer: customerForActor(ownership.customer, actor),
    })),
    orders: historyTotals(value.orders, actor),
  });
});
export const vehiclePATCH = withApi(async (req, ctx, actor) => {
  requireRole(actor, "ADMIN", "RECEPTION");
  const { id } = await ctx.params;
  const { archived, ...input } = vehiclePatch.parse(await body(req));
  const value = await db.$transaction(async (tx) => {
    const before = await tx.vehicle.findUnique({ where: { id } });
    if (!before) fail(404, "Автомобиль не найден");
    if (input.mileage !== undefined && input.mileage < before.mileage)
      fail(422, "Пробег не может быть меньше последнего зафиксированного");
    if (input.customerId && input.customerId !== before.customerId) {
      if (
        !(await tx.customer.findFirst({
          where: { id: input.customerId, archivedAt: null },
          select: { id: true },
        }))
      )
        fail(422, "Выберите активного клиента");
      const now = new Date();
      await tx.vehicleOwnership.updateMany({
        where: { vehicleId: id, endedAt: null },
        data: { endedAt: now },
      });
      await tx.vehicleOwnership.create({
        data: { vehicleId: id, customerId: input.customerId, startedAt: now },
      });
      await audit(tx, actor.id, "OWNER_CHANGE", "Vehicle", id, {
        from: before.customerId,
        to: input.customerId,
      });
    }
    const result = await tx.vehicle.update({
      where: { id },
      data: {
        ...input,
        ...(archived === undefined
          ? {}
          : { archivedAt: archived ? new Date() : null }),
      },
    });
    await audit(
      tx,
      actor.id,
      archived === undefined ? "UPDATE" : archived ? "ARCHIVE" : "RESTORE",
      "Vehicle",
      id,
      {
        fields: [
          ...Object.keys(input),
          ...(archived === undefined ? [] : ["archived"]),
        ],
      },
    );
    return result;
  }, serial);
  return json(value);
});

export const staffGET = withApi(async (_req, _ctx, actor) =>
  json({
    items: await db.user.findMany({
      where: actor.role === "MASTER" ? { role: "MASTER", active: true } : {},
      select: staffSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  }),
);
export const staffPOST = withApi(async (req, _ctx, actor) => {
  requireRole(actor, "ADMIN");
  const { password, ...input } = staffCreate.parse(await body(req));
  const passwordHash = await hashPassword(password);
  const value = await db.$transaction(async (tx) => {
    const result = await tx.user.create({
      data: { ...input, passwordHash },
      select: staffSelect,
    });
    await audit(tx, actor.id, "CREATE", "User", result.id, {
      role: input.role,
    });
    return result;
  });
  return json(value, 201);
});
export const staffPATCH = withApi(async (req, ctx, actor) => {
  requireRole(actor, "ADMIN");
  const { id } = await ctx.params;
  const { password, ...input } = staffPatch.parse(await body(req));
  const passwordHash = password ? await hashPassword(password) : undefined;
  const value = await db.$transaction(async (tx) => {
    const before = await tx.user.findUnique({
      where: { id },
      select: staffSelect,
    });
    if (!before) fail(404, "Сотрудник не найден");
    if (
      before.role === "ADMIN" &&
      before.active &&
      ((input.role !== undefined && input.role !== "ADMIN") ||
        input.active === false) &&
      (await tx.user.count({ where: { role: "ADMIN", active: true } })) <= 1
    )
      fail(
        409,
        "Нельзя отключить или изменить роль последнего активного администратора",
      );
    const revokeSessions =
      !!passwordHash ||
      (input.role !== undefined && input.role !== before.role) ||
      (input.active !== undefined && input.active !== before.active);
    const result = await tx.user.update({
      where: { id },
      data: {
        ...input,
        ...(passwordHash ? { passwordHash } : {}),
        ...(revokeSessions ? { authVersion: { increment: 1 } } : {}),
      },
      select: staffSelect,
    });
    if (revokeSessions) await tx.session.deleteMany({ where: { userId: id } });
    await audit(tx, actor.id, "UPDATE", "User", id, {
      fields: [...Object.keys(input), ...(passwordHash ? ["password"] : [])],
    });
    return result;
  }, serial);
  return json(value);
});
export const catalogGET = withApi(async () =>
  json({
    items: await db.catalogItem.findMany({
      orderBy: [{ sortOrder: "asc" }, { category: "asc" }, { name: "asc" }],
    }),
  }),
);
export const catalogPOST = withApi(async (req, _ctx, actor) => {
  requireRole(actor, "ADMIN");
  const input = catalogCreate.parse(await body(req));
  const result = await db.$transaction(async (tx) => {
    const value = await tx.catalogItem.create({ data: input });
    await audit(tx, actor.id, "CREATE", "CatalogItem", value.id, input);
    return value;
  });
  return json(result, 201);
});
export const catalogPATCH = withApi(async (req, ctx, actor) => {
  requireRole(actor, "ADMIN");
  const { id } = await ctx.params;
  const input = catalogPatch.parse(await body(req));
  const result = await db.$transaction(async (tx) => {
    const before = await tx.catalogItem.findUnique({ where: { id } });
    if (!before) fail(404, "Позиция не найдена");
    const value = await tx.catalogItem.update({ where: { id }, data: input });
    await audit(tx, actor.id, "UPDATE", "CatalogItem", id, {
      ...input,
      ...(input.laborPriceCents === undefined
        ? {}
        : { previousLaborPriceCents: before.laborPriceCents }),
    });
    return value;
  });
  return json(result);
});
export const settingsGET = withApi(async (_req, _ctx, actor) => {
  requireRole(actor, "ADMIN", "RECEPTION");
  return json(
    (await db.serviceSettings.findUnique({ where: { id: "main" } })) ?? {
      id: "main",
      name: "Автосервис",
      address: "",
      phone: "",
      taxId: "",
      timezone: "Europe/Kaliningrad",
    },
  );
});
export const settingsPATCH = withApi(async (req, _ctx, actor) => {
  requireRole(actor, "ADMIN");
  const input = settingsPatch.parse(await body(req));
  const value = await db.$transaction(async (tx) => {
    const value = await tx.serviceSettings.upsert({
      where: { id: "main" },
      create: { id: "main", ...input },
      update: input,
    });
    await audit(tx, actor.id, "UPDATE", "ServiceSettings", "main", input);
    return value;
  });
  return json(value);
});
