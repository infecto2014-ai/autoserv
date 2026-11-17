import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/types";
export function orderScope(actor: Actor): Prisma.WorkOrderWhereInput {
  return actor.role === "MASTER" ? { masterId: actor.id } : {};
}
export function customerScope(actor: Actor): Prisma.CustomerWhereInput {
  return actor.role === "MASTER"
    ? { orders: { some: { masterId: actor.id } } }
    : {};
}
export function vehicleScope(actor: Actor): Prisma.VehicleWhereInput {
  return actor.role === "MASTER"
    ? { orders: { some: { masterId: actor.id } } }
    : {};
}
