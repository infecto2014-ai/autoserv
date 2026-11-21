import { describe, expect, it } from "vitest";
import { allocatePayment, calculateWorkflowTotals } from "../shared/workflow-money";
import type { OrderLine } from "../shared/types";

function line(kind: OrderLine["kind"], cents: number, options: Partial<OrderLine> = {}): OrderLine {
  return {
    kind, quantityMilli: 1000, unitPriceCents: cents, name: "Позиция",
    article: "", variant: "NONE", approval: "APPROVED", completed: true,
    partSource: "SERVICE", ...options,
  };
}

describe("расчёт согласованного заказа", () => {
  const lines = [
    line("LABOR", 400_000), line("PART", 600_000),
    line("LABOR", 200_000, { approval: "DEFERRED" }),
    line("PART", 500_000, { partSource: "CUSTOMER" }),
    line("LABOR", 100_000, { approval: "PENDING" }),
    line("LABOR", 90_000, { approval: undefined }),
  ];

  it("применяет скидку к работам и включает только согласованный состав", () => {
    expect(calculateWorkflowTotals(lines, 100_000, 300_000)).toEqual({
      laborCents: 400_000, partsCents: 600_000, subtotalCents: 1_000_000,
      discountCents: 100_000, totalCents: 900_000, paidCents: 300_000,
      balanceCents: 600_000, overpaidCents: 0,
    });
    expect(allocatePayment(300_000, 300_000, 600_000))
      .toEqual({ laborCents: 100_000, partsCents: 200_000, unallocatedCents: 0 });
  });

  it("пересчитывает выдачу по фактическому выполнению", () => {
    const pending = line("LABOR", 10_000, { completed: false });
    expect(calculateWorkflowTotals([pending]).totalCents).toBe(10_000);
    expect(calculateWorkflowTotals([pending], 0, 0, true).totalCents).toBe(0);
    expect(() => calculateWorkflowTotals([pending], 1, 0, true)).toThrow();
  });

  it("ограничивает скидку стоимостью работ и сохраняет переплату", () => {
    expect(() => calculateWorkflowTotals(lines, 400_001)).toThrow();
    expect(calculateWorkflowTotals(lines, 400_000, 610_000)).toMatchObject({
      totalCents: 600_000, balanceCents: 0, overpaidCents: 10_000,
    });
    expect(calculateWorkflowTotals([], 0, 1)).toMatchObject({ totalCents: 0, overpaidCents: 1 });
    expect(calculateWorkflowTotals([line("PART", 300, { partSource: undefined })]).totalCents).toBe(0);
  });

  it("распределяет целые копейки детерминированно с сохранением суммы", () => {
    expect(allocatePayment(1, 1, 1)).toEqual({ laborCents: 1, partsCents: 0, unallocatedCents: 0 });
    expect(allocatePayment(1, 1, 2)).toEqual({ laborCents: 0, partsCents: 1, unallocatedCents: 0 });
    expect(allocatePayment(300, 0, 0)).toEqual({ laborCents: 0, partsCents: 0, unallocatedCents: 300 });
    expect(allocatePayment(0, 0, 0)).toEqual({ laborCents: 0, partsCents: 0, unallocatedCents: 0 });
    expect(allocatePayment(999_999_999, 499_999_999, 500_000_001)).toEqual({
      laborCents: 499_999_999, partsCents: 500_000_000, unallocatedCents: 0,
    });
    expect(() => allocatePayment(0.5, 0, 0)).toThrow();
    expect(() => calculateWorkflowTotals([], -1)).toThrow();
  });
});
