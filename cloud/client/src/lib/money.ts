import type { Totals } from "./types";
export const MAX_MONEY = 1_000_000_000;
export const MAX_QUANTITY = 100_000_000;
function scaled(value: string, digits: number, max: number): number {
  const input = value
    .trim()
    .replace(/[\s\u00a0]/g, "")
    .replace(",", ".");
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`).test(input))
    throw new Error("Введите неотрицательное число с допустимой точностью");
  const [whole, fraction = ""] = input.split(".");
  const n =
    BigInt(whole) * 10n ** BigInt(digits) +
    BigInt(fraction.padEnd(digits, "0"));
  if (n > BigInt(max)) throw new Error("Превышен допустимый предел");
  return Number(n);
}
export const parseMoney = (value: string) => scaled(value, 2, MAX_MONEY);
export const parseQuantity = (value: string) => scaled(value, 3, MAX_QUANTITY);
export function validInteger(value: number, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error("Недопустимое числовое значение");
  return value;
}
export function lineTotal(
  quantityMilli: number,
  unitPriceCents: number,
): number {
  validInteger(quantityMilli, MAX_QUANTITY);
  validInteger(unitPriceCents);
  return validInteger(
    Number((BigInt(quantityMilli) * BigInt(unitPriceCents) + 500n) / 1000n),
  );
}
export function calculateTotals(
  lines: {
    kind: "LABOR" | "PART";
    quantityMilli: number;
    unitPriceCents: number;
  }[],
  discountCents = 0,
  paidCents = 0,
): Totals {
  let laborCents = 0,
    partsCents = 0;
  for (const row of lines) {
    const sum = lineTotal(row.quantityMilli, row.unitPriceCents);
    if (row.kind === "LABOR") laborCents = validInteger(laborCents + sum);
    else if (row.kind === "PART") partsCents = validInteger(partsCents + sum);
    else throw new Error("Неизвестный тип строки");
  }
  const subtotalCents = validInteger(laborCents + partsCents);
  validInteger(discountCents);
  validInteger(paidCents);
  if (discountCents > subtotalCents)
    throw new Error("Скидка превышает сумму заказа");
  const totalCents = subtotalCents - discountCents;
  if (paidCents > totalCents) throw new Error("Оплата превышает сумму заказа");
  return {
    laborCents,
    partsCents,
    subtotalCents,
    discountCents,
    totalCents,
    paidCents,
    balanceCents: totalCents - paidCents,
    overpaidCents: 0,
  };
}
export function formatMoney(cents: number): string {
  return (
    (cents / 100).toLocaleString("ru-RU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " ₽"
  );
}
export function formatQuantity(milli: number): string {
  return (milli / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}
