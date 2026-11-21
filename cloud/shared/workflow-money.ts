import { calculateTotals, validInteger } from "./money";
import type { OrderLine, PaymentAllocation, WorkflowTotals } from "./types";

type PricedLine = Pick<OrderLine,
  "kind" | "quantityMilli" | "unitPriceCents" | "approval" | "completed" | "partSource"
>;

export function calculateWorkflowTotals(
  lines: readonly PricedLine[],
  discountCents = 0,
  paidCents = 0,
  finalized = false,
): WorkflowTotals {
  const billable = lines.filter(line =>
    line.approval === "APPROVED" &&
    (!finalized || line.completed === true) &&
    (line.kind === "LABOR" || line.partSource === "SERVICE"),
  );
  const gross = calculateTotals(billable);
  validInteger(discountCents);
  validInteger(paidCents);
  if (discountCents > gross.laborCents)
    throw new Error("Скидка превышает стоимость работ");

  const totalCents = gross.subtotalCents - discountCents;
  return {
    ...gross,
    discountCents,
    totalCents,
    paidCents,
    balanceCents: Math.max(0, totalCents - paidCents),
    overpaidCents: Math.max(0, paidCents - totalCents),
  };
}

export function allocatePayment(
  amountCents: number,
  laborNetCents: number,
  partsCents: number,
): PaymentAllocation {
  validInteger(amountCents);
  validInteger(laborNetCents);
  validInteger(partsCents);
  const total = BigInt(validInteger(laborNetCents + partsCents));
  if (total === 0n)
    return { laborCents: 0, partsCents: 0, unallocatedCents: amountCents };

  // Округляем долю работ до копейки, ровно половину — вверх.
  const laborCents = Number((BigInt(amountCents) * BigInt(laborNetCents) + total / 2n) / total);
  return { laborCents, partsCents: amountCents - laborCents, unallocatedCents: 0 };
}
