import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  actor: {
    id: "admin",
    name: "Admin",
    email: "admin@example.test",
    role: "ADMIN",
  },
  tx: {
    user: { findUnique: vi.fn(), count: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    vehicle: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    customer: { findFirst: vi.fn(), findMany: vi.fn() },
    vehicleOwnership: { updateMany: vi.fn(), create: vi.fn() },
  },
  hash: vi.fn().mockResolvedValue("hash"),
}));
vi.mock("@/server/auth", () => ({
  sessionActor: async () => state.actor,
  hashPassword: state.hash,
}));
vi.mock("@/server/db", () => ({
  db: {
    $transaction: async (
      fn: ((tx: typeof state.tx) => unknown) | Promise<unknown>[],
    ) => (Array.isArray(fn) ? Promise.all(fn) : fn(state.tx)),
    vehicle: {
      findFirst: (...args: unknown[]) => state.tx.vehicle.findFirst(...args),
      findMany: (...args: unknown[]) => state.tx.vehicle.findMany(...args),
      count: (...args: unknown[]) => state.tx.vehicle.count(...args),
    },
    customer: {
      findFirst: (...args: unknown[]) => state.tx.customer.findFirst(...args),
      findMany: (...args: unknown[]) => state.tx.customer.findMany(...args),
    },
  },
}));
import {
  catalogPatch,
  customerCreate,
  customerGET,
  pagination,
  settingsPatch,
  staffPATCH,
  vehicleGET,
  vehiclePATCH,
  vehiclesGET,
} from "@/server/crud";
const context = { params: Promise.resolve({ id: "record" }) };
function patch(payload: unknown) {
  return new Request("http://localhost/api/resource/record", {
    method: "PATCH",
    headers: { origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost");
  vi.clearAllMocks();
  state.actor.role = "ADMIN";
  state.tx.auditEvent.create.mockResolvedValue({});
  state.tx.user.findUnique.mockResolvedValue({
    id: "record",
    name: "Admin",
    email: "a@example.test",
    role: "ADMIN",
    active: true,
  });
  state.tx.user.count.mockResolvedValue(1);
  state.tx.customer.findFirst.mockResolvedValue({ id: "current" });
  state.tx.customer.findMany.mockResolvedValue([{ id: "current" }]);
});
describe("CRUD validation", () => {
  it("rejects unknown fields, fractional/excess prices and invalid timezones", () => {
    expect(
      customerCreate.safeParse({
        kind: "PERSON",
        name: "Клиент",
        phone: "1234567",
        role: "ADMIN",
      }).success,
    ).toBe(false);
    for (const laborPriceCents of [
      0.5,
      -1,
      1000000001,
      Number.MAX_SAFE_INTEGER,
    ])
      expect(catalogPatch.safeParse({ laborPriceCents }).success).toBe(false);
    expect(settingsPatch.safeParse({ timezone: "Mars/Olympus" }).success).toBe(
      false,
    );
    expect(
      settingsPatch.safeParse({ timezone: "Europe/Kaliningrad" }).success,
    ).toBe(true);
  });
  it("bounds pagination rather than accepting giant queries", () => {
    expect(
      pagination(new Request("http://localhost/?page=2&pageSize=100")),
    ).toMatchObject({ page: 2, pageSize: 100 });
    expect(() =>
      pagination(new Request("http://localhost/?pageSize=101")),
    ).toThrow();
    expect(() => pagination(new Request("http://localhost/?page=0"))).toThrow();
  });
});
describe("staff server permissions and sessions", () => {
  it("rejects mutations by MASTER before writing", async () => {
    state.actor.role = "MASTER";
    expect((await staffPATCH(patch({ role: "ADMIN" }), context)).status).toBe(
      403,
    );
    expect(state.tx.user.findUnique).not.toHaveBeenCalled();
  });
  it("protects the last active administrator", async () => {
    expect((await staffPATCH(patch({ active: false }), context)).status).toBe(
      409,
    );
    expect(state.tx.user.update).not.toHaveBeenCalled();
  });
  it("revokes sessions on password change and returns only selected safe fields", async () => {
    state.tx.user.update.mockResolvedValue({
      id: "record",
      name: "Admin",
      email: "a@example.test",
      role: "ADMIN",
      active: true,
    });
    const response = await staffPATCH(
      patch({ password: "a secure password" }),
      context,
    );
    expect(response.status).toBe(200);
    expect(state.tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "record" },
    });
    expect(state.tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, name: true, email: true, role: true, active: true },
      }),
    );
    expect(state.tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authVersion: { increment: 1 } }),
      }),
    );
    const result = await response.json();
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("authVersion");
  });
  it("rejects requests from another origin", async () => {
    const request = new Request("http://localhost/api/staff/record", {
      method: "PATCH",
      headers: { origin: "https://evil.test" },
      body: "{}",
    });
    expect((await staffPATCH(request, context)).status).toBe(403);
  });
});
describe("vehicle ownership and history", () => {
  it("changes owner and closes ownership records in the same transaction", async () => {
    state.tx.vehicle.findUnique.mockResolvedValue({
      id: "record",
      customerId: "old",
    });
    state.tx.customer.findFirst.mockResolvedValue({ id: "new" });
    state.tx.vehicle.update.mockResolvedValue({
      id: "record",
      customerId: "new",
    });
    expect(
      (await vehiclePATCH(patch({ customerId: "new" }), context)).status,
    ).toBe(200);
    expect(state.tx.vehicleOwnership.updateMany).toHaveBeenCalledWith({
      where: { vehicleId: "record", endedAt: null },
      data: { endedAt: expect.any(Date) },
    });
    expect(state.tx.vehicleOwnership.create).toHaveBeenCalledWith({
      data: {
        vehicleId: "record",
        customerId: "new",
        startedAt: expect.any(Date),
      },
    });
    expect(state.tx.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "OWNER_CHANGE",
          data: { from: "old", to: "new" },
        }),
      }),
    );
  });
  it("scopes the vehicle and every nested order for MASTER", async () => {
    state.actor.role = "MASTER";
    state.tx.vehicle.findFirst.mockResolvedValue({
      id: "record",
      customer: {
        id: "current",
        kind: "PERSON",
        name: "Current",
        archivedAt: null,
      },
      ownerships: [],
      orders: [],
    });
    expect(
      (
        await vehicleGET(
          new Request("http://localhost/api/vehicles/record"),
          context,
        )
      ).status,
    ).toBe(200);
    expect(state.tx.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ id: "record" }, { orders: { some: { masterId: "admin" } } }],
        },
        include: expect.objectContaining({
          orders: expect.objectContaining({ where: { masterId: "admin" } }),
        }),
      }),
    );
  });
});

describe("MASTER private data and mileage", () => {
  const owner = {
    id: "current",
    kind: "PERSON",
    name: "Текущий владелец",
    phone: "secret phone",
    phoneNormalized: "12345",
    email: "private@example.test",
    comment: "private note",
    archivedAt: null,
  };
  const order = {
    id: "order",
    customer: owner,
    vehicle: { id: "vehicle", customerId: "current" },
    discountCents: 100,
    paidCents: 200,
    lines: [{ kind: "LABOR", quantityMilli: 1000, unitPriceCents: 1000 }],
  };
  it.each(["customer", "vehicle"])(
    "redacts financial history through %s GET",
    async (endpoint) => {
      state.actor.role = "MASTER";
      const value = {
        id: "record",
        customer: owner,
        ownerships: [{ customer: owner }],
        orders: [order],
      };
      state.tx.vehicle.findFirst.mockResolvedValue(value);
      state.tx.customer.findFirst.mockResolvedValue(value);
      const response = await (
        endpoint === "customer" ? customerGET : vehicleGET
      )(new Request("http://localhost/api/" + endpoint + "/record"), context);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.orders[0]).toMatchObject({
        discountCents: 0,
        paidCents: 0,
        lines: [{ unitPriceCents: 0 }],
        documents: [],
        totals: { totalCents: 0, paidCents: 0, balanceCents: 0 },
      });
      expect(result.orders[0].customer).toMatchObject({
        id: "current",
        name: "Текущий владелец",
        phone: "",
        email: null,
        comment: "",
      });
      if (endpoint === "vehicle") {
        expect(JSON.stringify(result)).not.toContain("private");
        expect(JSON.stringify(result)).not.toContain("secret phone");
      }
    },
  );
  it("returns only minimal current owner details in vehicle search", async () => {
    state.actor.role = "MASTER";
    state.tx.vehicle.findMany.mockResolvedValue([
      { id: "record", customerId: "current", customer: owner },
    ]);
    state.tx.vehicle.count.mockResolvedValue(1);
    const response = await vehiclesGET(
      new Request("http://localhost/api/vehicles"),
      context,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].customer).toEqual({
      id: "current",
      kind: "PERSON",
      name: "Текущий владелец",
      phone: "",
      email: null,
      comment: "",
      archivedAt: null,
    });
  });
  it("rejects mileage regression before updating owner, vehicle or audit", async () => {
    state.tx.vehicle.findUnique.mockResolvedValue({
      id: "record",
      customerId: "old",
      mileage: 50000,
    });
    expect(
      (
        await vehiclePATCH(
          patch({ mileage: 49999, customerId: "new" }),
          context,
        )
      ).status,
    ).toBe(422);
    expect(state.tx.vehicle.update).not.toHaveBeenCalled();
    expect(state.tx.vehicleOwnership.create).not.toHaveBeenCalled();
    expect(state.tx.auditEvent.create).not.toHaveBeenCalled();
  });
  it("preserves financial history for reception", async () => {
    state.actor.role = "RECEPTION";
    state.tx.vehicle.findFirst.mockResolvedValue({
      id: "record",
      customer: owner,
      ownerships: [],
      orders: [order],
    });
    const response = await vehicleGET(
      new Request("http://localhost/api/vehicles/record"),
      context,
    );
    const result = await response.json();
    expect(result.orders[0]).toMatchObject({
      discountCents: 100,
      paidCents: 200,
      lines: [{ unitPriceCents: 1000 }],
      totals: { totalCents: 900, balanceCents: 700 },
    });
    expect(result.customer.email).toBe("private@example.test");
  });
});

describe("staff authentication version", () => {
  it.each([{ role: "RECEPTION" }, { active: false }])(
    "increments authVersion atomically and revokes sessions for %o",
    async (input) => {
      state.tx.user.count.mockResolvedValue(2);
      state.tx.user.update.mockResolvedValue({
        id: "record",
        name: "Admin",
        email: "a@example.test",
        role: input.role ?? "ADMIN",
        active: input.active ?? true,
      });
      expect((await staffPATCH(patch(input), context)).status).toBe(200);
      expect(state.tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ authVersion: { increment: 1 } }),
        }),
      );
      expect(state.tx.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: "record" },
      });
    },
  );
  it("does not revoke unchanged role or profile-only updates", async () => {
    state.tx.user.update.mockResolvedValue({
      id: "record",
      name: "Changed",
      email: "a@example.test",
      role: "ADMIN",
      active: true,
    });
    expect(
      (
        await staffPATCH(
          patch({ name: "Changed", role: "ADMIN", active: true }),
          context,
        )
      ).status,
    ).toBe(200);
    expect(state.tx.user.update.mock.calls[0][0].data).not.toHaveProperty(
      "authVersion",
    );
    expect(state.tx.session.deleteMany).not.toHaveBeenCalled();
  });
});

describe("outside-scope current vehicle owners", () => {
  const outsider = {
    id: "outsider-secret-id",
    kind: "COMPANY",
    name: "Secret Current Owner",
    phone: "secret phone",
    email: "secret@example.test",
    comment: "secret comment",
    archivedAt: "2026-01-01",
  };
  const former = {
    id: "assigned-former",
    kind: "PERSON",
    name: "Assigned Former Owner",
    archivedAt: null,
  };
  const vehicle = {
    id: "vehicle",
    customerId: outsider.id,
    customer: outsider,
    ownerships: [{ customerId: former.id, customer: former }],
    orders: [
      {
        id: "assigned-order",
        customer: former,
        vehicle: { id: "vehicle", customerId: outsider.id },
        discountCents: 0,
        paidCents: 0,
        lines: [],
      },
    ],
  };
  it("hides identity in vehicle detail and nested history after an ownership change", async () => {
    state.actor.role = "MASTER";
    state.tx.vehicle.findFirst.mockResolvedValue(vehicle);
    state.tx.customer.findFirst.mockResolvedValue(null);
    const response = await vehicleGET(
      new Request("http://localhost/api/vehicles/record"),
      context,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.customer).toBeNull();
    expect(result.customerId).toBe("");
    expect(result.orders[0].vehicle.customerId).toBe("");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain(outsider.name);
    expect(state.tx.customer.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [{ id: outsider.id }, { orders: { some: { masterId: "admin" } } }],
      },
      select: { id: true },
    });
  });
  it("checks owners in one bulk query and conceals unrelated owners in vehicle list", async () => {
    state.actor.role = "MASTER";
    state.tx.vehicle.findMany.mockResolvedValue([
      { id: vehicle.id, customerId: outsider.id, customer: outsider },
      { id: "other-vehicle", customerId: former.id, customer: former },
    ]);
    state.tx.vehicle.count.mockResolvedValue(2);
    state.tx.customer.findMany.mockResolvedValue([{ id: former.id }]);
    const response = await vehiclesGET(
      new Request("http://localhost/api/vehicles"),
      context,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items[0]).toMatchObject({ customerId: "", customer: null });
    expect(result.items[1].customer.name).toBe(former.name);
    expect(JSON.stringify(result)).not.toContain(outsider.id);
    expect(JSON.stringify(result)).not.toContain(outsider.name);
    expect(state.tx.customer.findMany).toHaveBeenCalledOnce();
    expect(state.tx.customer.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: { in: [outsider.id, former.id] } },
          { orders: { some: { masterId: "admin" } } },
        ],
      },
      select: { id: true },
    });
  });
});
