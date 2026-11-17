import { expect, it } from "vitest";
import { canTransition } from "@/lib/status";
it("разрешает последовательные переходы и запрещает повторное открытие", () => {
  expect(canTransition("NEW", "DIAGNOSTICS", "MASTER")).toBe(true);
  expect(canTransition("NEW", "READY", "ADMIN")).toBe(false);
  expect(canTransition("READY", "DELIVERED", "MASTER")).toBe(false);
  expect(canTransition("IN_PROGRESS", "CANCELLED", "RECEPTION")).toBe(true);
  expect(canTransition("DELIVERED", "NEW", "ADMIN")).toBe(false);
});
