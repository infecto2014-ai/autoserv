import { describe, it, expect } from "vitest";
import {
  parseMoney,
  parseQuantity,
  lineTotal,
  calculateTotals,
} from "@/lib/money";
describe("деньги и количество", () => {
  it("разбирает рубли без float и отклоняет некорректные цены", () => {
    expect(parseMoney("1 234,56")).toBe(123456);
    for (const s of ["-1", "1.234", "1e5", "NaN", ""])
      expect(() => parseMoney(s)).toThrow();
  });
  it("работает с тысячными и округляет ровно половину копейки вверх", () => {
    expect(parseQuantity("1,125")).toBe(1125);
    expect(lineTotal(1500, 101)).toBe(152);
  });
  it("считает работы, выбранную запчасть, скидку и остаток отдельно", () => {
    expect(
      calculateTotals(
        [
          { kind: "LABOR", quantityMilli: 1000, unitPriceCents: 150000 },
          { kind: "LABOR", quantityMilli: 2000, unitPriceCents: 70000 },
          { kind: "PART", quantityMilli: 1000, unitPriceCents: 90000 },
        ],
        10000,
        100000,
      ),
    ).toEqual({
      laborCents: 290000,
      partsCents: 90000,
      subtotalCents: 380000,
      discountCents: 10000,
      totalCents: 370000,
      paidCents: 100000,
      balanceCents: 270000,
    });
  });
  it("не допускает переплату, скидку больше итога и переполнение", () => {
    expect(() => calculateTotals([], 1)).toThrow();
    expect(() => calculateTotals([], 0, 1)).toThrow();
    expect(() => lineTotal(100000000, 1000000000)).toThrow();
    expect(() => lineTotal(1.1, 100)).toThrow();
  });
});
