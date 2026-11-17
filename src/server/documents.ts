import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/types";
import type { DocumentSnapshot } from "@/documents/types";
import { renderDocument } from "@/documents/render";
import { db } from "./db";
import { body, requireRole, fail } from "./http";
import {
  lockOrder,
  nextNumber,
  totalsForOrder,
  audit,
  versionField,
} from "./orders";
const schema = z
  .object({ kind: z.enum(["INSPECTION", "WORK_ORDER"]), version: versionField })
  .strict();
export async function createDocument(
  request: Request,
  id: string,
  actor: Actor,
) {
  requireRole(actor, "ADMIN", "RECEPTION");
  const input = schema.parse(await body(request));
  return db.$transaction(
    async (tx) => {
      const order = await lockOrder(tx, id, actor, input.version, true);
      const settings = await tx.serviceSettings.findUnique({
        where: { id: "main" },
      });
      if (!settings) fail(422, "Заполните реквизиты автосервиса");
      const number = await nextNumber(
        tx,
        "document",
        input.kind === "INSPECTION" ? "АО" : "ЗНД",
      );
      const snapshot: DocumentSnapshot = {
        kind: input.kind,
        number,
        createdAt: new Date().toISOString(),
        templateVersion: "1.0",
        settings: {
          name: settings.name,
          address: settings.address,
          phone: settings.phone,
          taxId: settings.taxId,
          timezone: settings.timezone,
        },
        order: {
          number: order.number,
          openedAt: order.openedAt.toISOString(),
          mileage: order.mileage,
          complaint: order.complaint,
          recommendations: order.recommendations,
          comment: order.comment,
          status: order.status,
        },
        customer: { name: order.customer.name, phone: order.customer.phone },
        vehicle: {
          make: order.vehicle.make,
          model: order.vehicle.model,
          year: order.vehicle.year,
          vin: order.vehicle.vin,
          plate: order.vehicle.plate,
        },
        masterName: order.master?.name ?? "Не назначен",
        inspectionItems: order.inspectionItems.map(
          ({
            id,
            category,
            name,
            left,
            right,
            condition,
            quantityMilli,
            laborPriceCents,
            originalPriceCents,
            analogPriceCents,
            customPriceCents,
            selectedPart,
            note,
          }) => ({
            id,
            category,
            name,
            left,
            right,
            condition,
            quantityMilli,
            laborPriceCents,
            originalPriceCents,
            analogPriceCents,
            customPriceCents,
            selectedPart,
            note,
          }),
        ),
        lines: order.lines.map(
          ({
            kind,
            name,
            quantityMilli,
            unitPriceCents,
            variant,
            article,
          }) => ({
            kind,
            name,
            quantityMilli,
            unitPriceCents,
            variant,
            article,
          }),
        ),
        totals: totalsForOrder(order),
      };
      const pdf = await renderDocument(snapshot);
      const latest = await tx.document.aggregate({
        where: { orderId: id, kind: input.kind },
        _max: { version: true },
      });
      const document = await tx.document.create({
        data: {
          orderId: id,
          number,
          kind: input.kind,
          version: (latest._max.version ?? 0) + 1,
          templateVersion: snapshot.templateVersion,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          pdf: new Uint8Array(pdf),
          sha256: createHash("sha256").update(pdf).digest("hex"),
          authorId: actor.id,
        },
        select: {
          id: true,
          number: true,
          kind: true,
          version: true,
          createdAt: true,
          sha256: true,
        },
      });
      await audit(tx, actor, "DOCUMENT_CREATED", id, {
        documentId: document.id,
        number,
        sha256: document.sha256,
        orderVersion: order.version,
      });
      return document;
    },
    { timeout: 30000 },
  );
}
