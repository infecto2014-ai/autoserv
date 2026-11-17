import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceSettings } from "@prisma/client";
import type { DocumentSnapshot } from "@/documents/types";
import type {
  Customer,
  DocumentMeta,
  InspectionItem,
  OrderDetail,
  Role,
  Vehicle,
} from "@/lib/types";
import { db } from "@/server/db";
import { createSession, hashPassword } from "@/server/auth";
import type { ApiContext } from "@/server/http";
import {
  catalogPOST,
  customerGET,
  customersPOST,
  settingsGET,
  settingsPATCH,
  staffPATCH,
  staffPOST,
  vehicleGET,
  vehiclePATCH,
  vehiclesGET,
  vehiclesPOST,
} from "@/server/crud";
import { POST as orderPOST } from "@/app/api/orders/route";
import {
  GET as orderGET,
  PATCH as orderPATCH,
} from "@/app/api/orders/[id]/route";
import { PUT as inspectionPUT } from "@/app/api/orders/[id]/inspection/route";
import { POST as transferPOST } from "@/app/api/orders/[id]/transfer/route";
import { PUT as linesPUT } from "@/app/api/orders/[id]/lines/route";
import { POST as documentPOST } from "@/app/api/orders/[id]/documents/route";
import { GET as documentGET } from "@/app/api/documents/[id]/route";

// Never connect to the application's ordinary database, even when opted in.
function isTestDatabase() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.pathname.slice(1).endsWith("_test")
    );
  } catch {
    return false;
  }
}
const enabled = process.env.RUN_DB_TESTS === "1";
const integration = enabled ? describe : describe.skip;
const origin = "http://localhost:3000";
type Handler = (request: Request, context: ApiContext) => Promise<Response>;
type Identity = { id: string; token: string };
type History = { orders: OrderDetail[] };

integration(
  "PostgreSQL API workflow (explicitly opt in on a _test database)",
  () => {
    const run = randomUUID();
    const userIds: string[] = [];
    const customerIds: string[] = [];
    const vehicleIds: string[] = [];
    const catalogIds: string[] = [];
    let admin: Identity;
    let reception: Identity;
    let master: Identity;
    let otherMaster: Identity;
    let previousSettings: ServiceSettings | null;
    let originalOrigin: string | undefined;

    function request(
      method: string,
      token?: string,
      payload?: unknown,
      requestOrigin = origin,
    ) {
      const headers = new Headers({ Origin: requestOrigin });
      if (token) headers.set("Cookie", `sto_session=${token}`);
      if (payload !== undefined)
        headers.set("Content-Type", "application/json");
      return new Request(`${origin}/api/integration`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    }
    function invoke(
      handler: Handler,
      method: string,
      actor?: Identity,
      payload?: unknown,
      id = "",
      requestOrigin = origin,
    ) {
      return handler(request(method, actor?.token, payload, requestOrigin), {
        params: Promise.resolve({ id }),
      });
    }
    async function json<T>(
      handler: Handler,
      method: string,
      actor: Identity,
      payload?: unknown,
      id = "",
      status = 200,
    ): Promise<T> {
      const response = await invoke(handler, method, actor, payload, id);
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(status);
      return result as T;
    }
    async function identity(role: Role, suffix: string): Promise<Identity> {
      const user = await db.user.create({
        data: {
          name: `Integration ${suffix} ${run}`,
          email: `${suffix}-${run}@integration.test`,
          role,
          passwordHash: await hashPassword(`Integration-${run}`),
        },
      });
      userIds.push(user.id);
      return { id: user.id, token: await createSession(user.id, 0) };
    }
    async function fixture() {
      const customer = await json<Customer>(
        customersPOST,
        "POST",
        reception,
        {
          kind: "PERSON",
          name: `Тестовый клиент ${run}`,
          phone: "+7 (999) 123-45-67",
          email: `customer-${run}@integration.test`,
          comment: "Synthetic integration fixture",
        },
        "",
        201,
      );
      customerIds.push(customer.id);
      const vehicle = await json<Vehicle>(
        vehiclesPOST,
        "POST",
        reception,
        {
          customerId: customer.id,
          make: "Тест",
          model: "Интеграция",
          mileage: 10000,
          plate: `TEST-${vehicleIds.length}-${run.slice(0, 8)}`,
        },
        "",
        201,
      );
      vehicleIds.push(vehicle.id);
      const order = await json<OrderDetail>(
        orderPOST,
        "POST",
        reception,
        {
          vehicleId: vehicle.id,
          masterId: master.id,
          mileage: 10100,
          complaint: "Синтетическая проверка тормозов и технических жидкостей",
        },
        "",
        201,
      );
      return { customer, vehicle, order };
    }
    function preparedItems(order: OrderDetail): InspectionItem[] {
      return order.inspectionItems.map((item) => {
        if (item.catalogItemId === catalogIds[0])
          return {
            ...item,
            quantityMilli: 1500,
            laborPriceCents: 12001,
            originalPriceCents: 80003,
            analogPriceCents: 50001,
            selectedPart: "ORIGINAL",
            condition: "REPAIR",
            left: true,
            note: "Левая сторона",
          };
        if (item.catalogItemId === catalogIds[1])
          return {
            ...item,
            quantityMilli: 2000,
            laborPriceCents: 7777,
            originalPriceCents: 90000,
            analogPriceCents: 40000,
            selectedPart: "NONE",
            condition: "RECOMMENDED",
            right: true,
          };
        return item;
      });
    }
    async function priced(order: OrderDetail) {
      order = await json<OrderDetail>(
        inspectionPUT,
        "PUT",
        reception,
        {
          version: order.version,
          items: preparedItems(order),
          recommendations: "Контроль после ремонта",
        },
        order.id,
      );
      const ids = order.inspectionItems
        .filter((item) => catalogIds.includes(item.catalogItemId ?? ""))
        .map((item) => item.id);
      return json<OrderDetail>(
        transferPOST,
        "POST",
        reception,
        { version: order.version, inspectionItemIds: ids },
        order.id,
      );
    }
    function expectHidden(order: OrderDetail) {
      expect(order).toMatchObject({
        discountCents: 0,
        paidCents: 0,
        documents: [],
        totals: {
          laborCents: 0,
          partsCents: 0,
          totalCents: 0,
          paidCents: 0,
          balanceCents: 0,
        },
      });
      expect(order.lines.length).toBeGreaterThan(0);
      for (const line of order.lines) expect(line.unitPriceCents).toBe(0);
      for (const item of order.inspectionItems ?? [])
        expect(item).toMatchObject({
          laborPriceCents: 0,
          originalPriceCents: 0,
          analogPriceCents: 0,
          customPriceCents: 0,
        });
    }

    beforeAll(async () => {
      // Guard again at the last possible point before the first database query.
      if (!enabled || !isTestDatabase())
        throw new Error(
          'RUN_DB_TESTS=1 requires DATABASE_URL for a PostgreSQL database whose name ends with "_test". Refusing to connect.',
        );
      originalOrigin = process.env.APP_ORIGIN;
      process.env.APP_ORIGIN = origin;
      previousSettings = await db.serviceSettings.findUnique({
        where: { id: "main" },
      });
      admin = await identity("ADMIN", "admin");
      reception = await identity("RECEPTION", "reception");
      master = await identity("MASTER", "master");
      otherMaster = await identity("MASTER", "other-master");
      await json(settingsPATCH, "PATCH", admin, {
        name: `Тестовый сервис ${run}`,
        address: "Тестовая улица, 1",
        timezone: "UTC",
      });
      for (const name of ["Тормозной механизм", "Техническая жидкость"]) {
        const item = await json<{ id: string }>(
          catalogPOST,
          "POST",
          admin,
          {
            category: `Integration ${run}`,
            name,
            laborPriceCents: 100,
          },
          "",
          201,
        );
        catalogIds.push(item.id);
      }
    }, 30000);

    afterAll(async () => {
      if (!enabled || !isTestDatabase()) return;
      // Only entities belonging to this run are removed. Shared seed data and sequences stay intact.
      try {
        const orders = await db.workOrder.findMany({
          where: { vehicleId: { in: vehicleIds } },
          select: { id: true },
        });
        const orderIds = orders.map((order) => order.id);
        await db.$transaction(
          async (tx) => {
            await tx.document.deleteMany({
              where: { orderId: { in: orderIds } },
            });
            await tx.orderLine.deleteMany({
              where: { orderId: { in: orderIds } },
            });
            await tx.inspectionItem.deleteMany({
              where: { orderId: { in: orderIds } },
            });
            await tx.workOrder.deleteMany({ where: { id: { in: orderIds } } });
            await tx.vehicleOwnership.deleteMany({
              where: { vehicleId: { in: vehicleIds } },
            });
            await tx.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
            await tx.customer.deleteMany({
              where: { id: { in: customerIds } },
            });
            await tx.catalogItem.deleteMany({
              where: { id: { in: catalogIds } },
            });
            await tx.auditEvent.deleteMany({
              where: { actorId: { in: userIds } },
            });
            await tx.session.deleteMany({ where: { userId: { in: userIds } } });
            await tx.user.deleteMany({ where: { id: { in: userIds } } });
            if (previousSettings)
              await tx.serviceSettings.upsert({
                where: { id: "main" },
                create: previousSettings,
                update: previousSettings,
              });
            else await tx.serviceSettings.deleteMany({ where: { id: "main" } });
          },
          { timeout: 20000 },
        );
      } finally {
        if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
        else process.env.APP_ORIGIN = originalOrigin;
        await db.$disconnect();
      }
    }, 30000);

    it("completes customer → vehicle → inspection → selected parts → immutable PDFs → paid delivery and history", async () => {
      const { customer, vehicle, order: initial } = await fixture();
      expect(initial.masterId).toBe(master.id);
      expect(
        initial.inspectionItems.filter((item) =>
          catalogIds.includes(item.catalogItemId ?? ""),
        ),
      ).toHaveLength(2);
      let order = await priced(initial);
      expect(order.lines.filter((line) => line.kind === "LABOR")).toHaveLength(
        2,
      );
      expect(order.lines.filter((line) => line.kind === "PART")).toHaveLength(
        1,
      );
      expect(order.lines.find((line) => line.kind === "PART")).toMatchObject({
        variant: "ORIGINAL",
        unitPriceCents: 80003,
        quantityMilli: 1500,
      });
      expect(order.totals).toMatchObject({
        laborCents: 33556,
        partsCents: 120005,
        totalCents: 153561,
      });
      const originalLineIds = order.lines.map((line) => line.id).sort();
      const ids = order.inspectionItems
        .filter((item) => catalogIds.includes(item.catalogItemId ?? ""))
        .map((item) => item.id);
      order = await json<OrderDetail>(
        transferPOST,
        "POST",
        reception,
        { version: order.version, inspectionItemIds: [...ids, ids[0]] },
        order.id,
      );
      expect(order.lines.map((line) => line.id).sort()).toEqual(
        originalLineIds,
      );

      order = await json<OrderDetail>(
        inspectionPUT,
        "PUT",
        reception,
        {
          version: order.version,
          items: order.inspectionItems.map((item) =>
            item.catalogItemId === catalogIds[0]
              ? { ...item, selectedPart: "ANALOG" }
              : item,
          ),
        },
        order.id,
      );
      order = await json<OrderDetail>(
        transferPOST,
        "POST",
        reception,
        { version: order.version, inspectionItemIds: ids },
        order.id,
      );
      expect(order.lines.map((line) => line.id).sort()).toEqual(
        originalLineIds,
      );
      expect(order.lines.find((line) => line.kind === "PART")).toMatchObject({
        variant: "ANALOG",
        unitPriceCents: 50001,
      });
      expect(order.totals).toEqual({
        laborCents: 33556,
        partsCents: 75002,
        subtotalCents: 108558,
        discountCents: 0,
        totalCents: 108558,
        paidCents: 0,
        balanceCents: 108558,
      });
      order = await json<OrderDetail>(
        orderPATCH,
        "PATCH",
        reception,
        { version: order.version, discountCents: 558 },
        order.id,
      );

      const saved = [];
      for (const kind of ["INSPECTION", "WORK_ORDER"] as const) {
        const meta = await json<DocumentMeta>(
          documentPOST,
          "POST",
          reception,
          { kind, version: order.version },
          order.id,
          201,
        );
        expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);
        const stored = await db.document.findUniqueOrThrow({
          where: { id: meta.id },
        });
        const snapshot = stored.snapshot as unknown as DocumentSnapshot;
        expect(snapshot.kind).toBe(kind);
        expect(snapshot.customer.name).toBe(customer.name);
        expect(snapshot.masterName).toContain("Integration master");
        expect(snapshot.totals).toMatchObject({
          totalCents: 108000,
          discountCents: 558,
        });
        expect(snapshot.lines).toHaveLength(3);
        const response = await invoke(
          documentGET,
          "GET",
          reception,
          undefined,
          meta.id,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/pdf");
        expect(response.headers.get("content-disposition")).toContain("inline");
        expect(response.headers.get("etag")).toBe(`"${meta.sha256}"`);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(bytes.length).toBeGreaterThan(1000);
        expect(bytes).toEqual(Buffer.from(stored.pdf));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          meta.sha256,
        );
        saved.push({
          id: meta.id,
          bytes,
          snapshot: stored.snapshot,
          sha256: meta.sha256,
        });
        order = await json<OrderDetail>(
          orderGET,
          "GET",
          reception,
          undefined,
          order.id,
        );
      }
      expect(order.documents).toHaveLength(2);
      await json(settingsPATCH, "PATCH", admin, {
        name: `Изменённый сервис ${run}`,
        address: "Другой адрес",
      });
      const part = order.lines.find((line) => line.kind === "PART");
      expect(part).toBeDefined();
      order = await json<OrderDetail>(
        linesPUT,
        "PUT",
        reception,
        {
          version: order.version,
          lines: order.lines.map((line) => ({
            id: line.id,
            kind: line.kind,
            name: line.name,
            quantityMilli: line.quantityMilli,
            unitPriceCents: line.kind === "PART" ? 60001 : line.unitPriceCents,
            variant: line.variant,
            article: line.article,
          })),
        },
        order.id,
      );
      expect(order.totals.totalCents).toBe(123000);
      for (const document of saved) {
        const stored = await db.document.findUniqueOrThrow({
          where: { id: document.id },
        });
        expect(stored.snapshot).toEqual(document.snapshot);
        expect(stored.sha256).toBe(document.sha256);
        const response = await invoke(
          documentGET,
          "GET",
          reception,
          undefined,
          document.id,
        );
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          document.bytes,
        );
      }

      expect(
        (
          await invoke(
            orderPATCH,
            "PATCH",
            reception,
            { version: order.version, status: "READY" },
            order.id,
          )
        ).status,
      ).toBe(422);
      for (const status of [
        "DIAGNOSTICS",
        "APPROVAL",
        "IN_PROGRESS",
        "READY",
      ] as const) {
        order = await json<OrderDetail>(
          orderPATCH,
          "PATCH",
          master,
          { version: order.version, status },
          order.id,
        );
        expect(order.status).toBe(status);
      }
      expect(
        (
          await invoke(
            orderPATCH,
            "PATCH",
            master,
            { version: order.version, status: "DELIVERED" },
            order.id,
          )
        ).status,
      ).toBe(422);
      expect(
        (
          await invoke(
            orderPATCH,
            "PATCH",
            reception,
            { version: order.version, status: "DELIVERED" },
            order.id,
          )
        ).status,
      ).toBe(422);
      order = await json<OrderDetail>(
        orderGET,
        "GET",
        reception,
        undefined,
        order.id,
      );
      order = await json<OrderDetail>(
        orderPATCH,
        "PATCH",
        reception,
        {
          version: order.version,
          paidCents: order.totals.totalCents,
          status: "DELIVERED",
        },
        order.id,
      );
      expect(order).toMatchObject({
        status: "DELIVERED",
        paidCents: 123000,
        totals: { balanceCents: 0 },
      });
      expect(order.closedAt).toBeTruthy();
      expect(
        (
          await invoke(
            orderPATCH,
            "PATCH",
            reception,
            { version: order.version, comment: "Cannot edit delivered" },
            order.id,
          )
        ).status,
      ).toBe(409);
      for (const [handler, id] of [
        [customerGET, customer.id],
        [vehicleGET, vehicle.id],
      ] as const) {
        const history = await json<History>(
          handler,
          "GET",
          reception,
          undefined,
          id,
        );
        expect(
          history.orders.find((item) => item.id === order.id),
        ).toMatchObject({
          status: "DELIVERED",
          paidCents: 123000,
          totals: { balanceCents: 0 },
        });
      }
      const events = await db.auditEvent.findMany({
        where: { entityId: order.id },
      });
      expect(events.map((event) => event.action)).toEqual(
        expect.arrayContaining([
          "ORDER_CREATED",
          "INSPECTION_SAVED",
          "INSPECTION_TRANSFERRED",
          "DOCUMENT_CREATED",
          "LINES_UPDATED",
          "ORDER_UPDATED",
        ]),
      );
    }, 120000);

    it("enforces assigned MASTER access, hides financial history, and rejects price/privilege mutations", async () => {
      const { customer, vehicle, order: initial } = await fixture();
      let order = await priced(initial);
      order = await json<OrderDetail>(
        orderPATCH,
        "PATCH",
        reception,
        {
          version: order.version,
          discountCents: 456,
          paidCents: 1234,
        },
        order.id,
      );
      const document = await json<DocumentMeta>(
        documentPOST,
        "POST",
        reception,
        {
          kind: "WORK_ORDER",
          version: order.version,
        },
        order.id,
        201,
      );
      order = await json<OrderDetail>(
        orderGET,
        "GET",
        reception,
        undefined,
        order.id,
      );
      expect(order.documents).toHaveLength(1);
      const visible = await json<OrderDetail>(
        orderGET,
        "GET",
        master,
        undefined,
        order.id,
      );
      expectHidden(visible);
      for (const [handler, id] of [
        [customerGET, customer.id],
        [vehicleGET, vehicle.id],
      ] as const) {
        const history = await json<History>(
          handler,
          "GET",
          master,
          undefined,
          id,
        );
        expect(history.orders).toHaveLength(1);
        expectHidden(history.orders[0]);
        expect(
          (await invoke(handler, "GET", otherMaster, undefined, id)).status,
        ).toBe(404);
      }
      expect(
        (await invoke(orderGET, "GET", otherMaster, undefined, order.id))
          .status,
      ).toBe(404);
      expect(
        (
          await invoke(
            orderPATCH,
            "PATCH",
            otherMaster,
            { version: order.version, comment: "Foreign" },
            order.id,
          )
        ).status,
      ).toBe(404);
      for (const payload of [
        { paidCents: 1 },
        { discountCents: 1 },
        { masterId: otherMaster.id },
      ]) {
        expect(
          (
            await invoke(
              orderPATCH,
              "PATCH",
              master,
              { version: order.version, ...payload },
              order.id,
            )
          ).status,
        ).toBe(403);
      }
      const changedPrices = visible.inspectionItems.map((item) =>
        item.catalogItemId === catalogIds[0]
          ? { ...item, laborPriceCents: 43210 }
          : item,
      );
      expect(
        (
          await invoke(
            inspectionPUT,
            "PUT",
            master,
            { version: visible.version, items: changedPrices },
            order.id,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await invoke(
            linesPUT,
            "PUT",
            master,
            { version: order.version, lines: [] },
            order.id,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await invoke(
            transferPOST,
            "POST",
            master,
            {
              version: order.version,
              inspectionItemIds: [order.inspectionItems[0].id],
            },
            order.id,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await invoke(
            documentPOST,
            "POST",
            master,
            { version: order.version, kind: "WORK_ORDER" },
            order.id,
          )
        ).status,
      ).toBe(403);
      expect(
        (await invoke(documentGET, "GET", master, undefined, document.id))
          .status,
      ).toBe(403);
      expect(
        (await invoke(documentGET, "GET", otherMaster, undefined, document.id))
          .status,
      ).toBe(403);
      expect((await invoke(settingsGET, "GET", master)).status).toBe(403);
      expect(
        (await invoke(settingsPATCH, "PATCH", master, { name: "Forbidden" }))
          .status,
      ).toBe(403);
      expect(
        (await invoke(staffPOST, "POST", master, { name: "Forbidden" })).status,
      ).toBe(403);
      expect(
        (
          await invoke(
            staffPATCH,
            "PATCH",
            master,
            { role: "ADMIN" },
            master.id,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await invoke(customersPOST, "POST", master, {
            kind: "PERSON",
            name: "Forbidden",
            phone: "12345",
          })
        ).status,
      ).toBe(403);
      expect(
        (await invoke(orderGET, "GET", undefined, undefined, order.id)).status,
      ).toBe(401);
      expect(
        (
          await invoke(
            orderPATCH,
            "PATCH",
            reception,
            { version: order.version, comment: "CSRF" },
            order.id,
            "https://foreign.test",
          )
        ).status,
      ).toBe(403);
      const afterRejected = await json<OrderDetail>(
        orderGET,
        "GET",
        reception,
        undefined,
        order.id,
      );
      expect(afterRejected.version).toBe(order.version);
      expect(afterRejected.lines).toEqual(order.lines);

      // A master saves redacted prices back as zero without destroying the real prices.
      const saved = await json<OrderDetail>(
        inspectionPUT,
        "PUT",
        master,
        {
          version: visible.version,
          recommendations: "Разрешённая рекомендация мастера",
          items: visible.inspectionItems.map((item) =>
            item.catalogItemId === catalogIds[0]
              ? {
                  ...item,
                  condition: "DONE",
                  note: "Проверено мастером",
                  right: true,
                }
              : item,
          ),
        },
        order.id,
      );
      expectHidden(saved);
      const actual = await json<OrderDetail>(
        orderGET,
        "GET",
        reception,
        undefined,
        order.id,
      );
      expect(
        actual.inspectionItems.find(
          (item) => item.catalogItemId === catalogIds[0],
        ),
      ).toMatchObject({
        condition: "DONE",
        note: "Проверено мастером",
        right: true,
        laborPriceCents: 12001,
        originalPriceCents: 80003,
      });
      expect(actual.totals).toEqual(order.totals);
      // A past assignment does not grant access to the next vehicle owner's identity.
      const nextOwner = await json<Customer>(
        customersPOST,
        "POST",
        reception,
        {
          kind: "PERSON",
          name: `Новый скрытый владелец ${run}`,
          phone: "+7 999 555 0000",
          email: `private-${run}@integration.test`,
        },
        "",
        201,
      );
      customerIds.push(nextOwner.id);
      await json<Vehicle>(
        vehiclePATCH,
        "PATCH",
        reception,
        { customerId: nextOwner.id },
        vehicle.id,
      );
      const ownedHistory = await json<Vehicle & History>(
        vehicleGET,
        "GET",
        master,
        undefined,
        vehicle.id,
      );
      expect(ownedHistory.customer).toBeNull();
      expect(ownedHistory.customerId).toBe("");
      expect(JSON.stringify(ownedHistory)).not.toContain(nextOwner.id);
      expect(JSON.stringify(ownedHistory)).not.toContain(nextOwner.name);
      const listResponse = await vehiclesGET(
        new Request(
          `${origin}/api/vehicles?q=${encodeURIComponent(nextOwner.name)}`,
          { headers: { Cookie: `sto_session=${master.token}` } },
        ),
        { params: Promise.resolve({}) },
      );
      expect(listResponse.status).toBe(200);
      expect((await listResponse.json()).total).toBe(0);
    }, 30000);

    it("allows exactly one writer of the same order version and rejects the stale retry", async () => {
      const { order } = await fixture();
      const responses = await Promise.all(
        ["first writer", "second writer"].map((comment) =>
          invoke(
            orderPATCH,
            "PATCH",
            reception,
            { version: order.version, comment },
            order.id,
          ),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      const winner = (await responses
        .find((response) => response.status === 200)!
        .json()) as OrderDetail;
      const stored = await json<OrderDetail>(
        orderGET,
        "GET",
        reception,
        undefined,
        order.id,
      );
      expect(stored.version).toBe(order.version + 1);
      expect(stored.comment).toBe(winner.comment);
      expect(
        (
          await invoke(
            orderPATCH,
            "PATCH",
            reception,
            { version: order.version, comment: "stale retry" },
            order.id,
          )
        ).status,
      ).toBe(409);
      expect(
        (await db.workOrder.findUniqueOrThrow({ where: { id: order.id } }))
          .comment,
      ).toBe(winner.comment);
    }, 30000);

    it("rejects a correctly signed-in but stale authVersion session", async () => {
      const user = await identity("MASTER", "stale-version");
      expect(
        (await invoke(orderGET, "GET", user, undefined, "missing-order"))
          .status,
      ).toBe(404);
      await db.user.update({
        where: { id: user.id },
        data: { authVersion: { increment: 1 } },
      });
      expect(
        (await invoke(orderGET, "GET", user, undefined, "missing-order"))
          .status,
      ).toBe(401);
      const fresh = { ...user, token: await createSession(user.id, 1) };
      expect(
        (await invoke(orderGET, "GET", fresh, undefined, "missing-order"))
          .status,
      ).toBe(404);
    });

    it("keeps vehicle mileage monotonic under concurrent edits and concurrent order creation", async () => {
      const { vehicle } = await fixture();
      const mileages = [11000, 12000];
      const responses = await Promise.all(
        mileages.map((mileage) =>
          invoke(vehiclePATCH, "PATCH", reception, { mileage }, vehicle.id),
        ),
      );
      for (const response of responses)
        expect([200, 409, 422]).toContain(response.status);
      const accepted = mileages.filter(
        (_, index) => responses[index].status === 200,
      );
      expect(accepted.length).toBeGreaterThan(0);
      let stored = await db.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(stored.mileage).toBe(Math.max(...accepted));
      // Serializable conflicts are retried by a client with freshly loaded state.
      if (responses[1].status === 409)
        await json(
          vehiclePATCH,
          "PATCH",
          reception,
          { mileage: 12000 },
          vehicle.id,
        );
      stored = await db.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(stored.mileage).toBe(12000);
      expect(
        (
          await invoke(
            vehiclePATCH,
            "PATCH",
            reception,
            { mileage: 11999 },
            vehicle.id,
          )
        ).status,
      ).toBe(422);

      const orderResponses = await Promise.all(
        [13000, 14000].map((mileage) =>
          invoke(orderPOST, "POST", reception, {
            vehicleId: vehicle.id,
            masterId: master.id,
            mileage,
            complaint: "Concurrent mileage check",
          }),
        ),
      );
      expect(orderResponses[1].status).toBe(201);
      expect([201, 422]).toContain(orderResponses[0].status);
      expect(
        (await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } }))
          .mileage,
      ).toBe(14000);
      expect(
        (
          await invoke(orderPOST, "POST", reception, {
            vehicleId: vehicle.id,
            mileage: 13999,
            complaint: "Regression rejected",
          })
        ).status,
      ).toBe(422);
    }, 30000);
  },
);
