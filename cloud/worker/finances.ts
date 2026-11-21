import {calculateWorkflowTotals, allocatePayment} from '../shared/workflow-money';
import {lineTotal} from '../shared/money';
import type {OrderDetail, Payment, PaymentAllocation, Totals} from '../shared/types';
import {fail} from './common';
import {stmt, uuid, now} from './db';
import type {Context, D1PreparedStatement} from './types';

type PricedOrder = Pick<OrderDetail, 'lines' | 'discountCents' | 'paidCents' | 'financialMode' | 'legacySnapshot'> & {status?: OrderDetail['status']};
export function totalsForOrder(order: PricedOrder) {
  if (order.financialMode === 'LEGACY') {
    const snapshot = order.legacySnapshot;
    if (!snapshot) fail(500, 'Не найден перенесённый расчёт');
    const {orderId: _, ...totals} = snapshot;
    return {...totals, paidCents: order.paidCents, balanceCents: Math.max(0, totals.totalCents-order.paidCents), overpaidCents: Math.max(0, order.paidCents-totals.totalCents)};
  }
  try {
    for (const line of order.lines) lineTotal(line.quantityMilli, line.unitPriceCents);
    return calculateWorkflowTotals(order.lines, order.discountCents, order.paidCents, order.status === 'DELIVERED');
  } catch (error) {fail(422, error instanceof Error ? error.message : 'Ошибка расчёта');}
}

export function paidFromLedger(payments: Payment[]) {
  const net = payments.reduce((sum,p) => sum + (p.kind === 'REFUND' ? -BigInt(p.amountCents) : BigInt(p.amountCents)),0n);
  const paid = Number(net);
  if (!Number.isSafeInteger(paid) || paid < 0) fail(422,'Недопустимый остаток журнала платежей');
  return paid;
}

export function assertReviewed(order: OrderDetail) {
  if (order.financialMode === 'LEGACY') fail(409, 'Подтвердите проверку перенесённого расчёта');
}
export function pendingAllocations(ctx: Context, order: OrderDetail, totals: Totals): D1PreparedStatement[] {
  if (!totals.totalCents) return [];
  const payments = order.payments ?? [];
  const allocations: {id: string; laborCents: number; partsCents: number; unallocatedCents: number}[] = [];
  const refunds = new Map<string,number>();
  for (const r of payments) {
    if (r.relatedPaymentId) refunds.set(r.relatedPaymentId, (refunds.get(r.relatedPaymentId) ?? 0) + r.unallocatedCents);
  }
  for (const p of payments) {
    if (p.kind !== 'PAYMENT' || p.laborCents || p.partsCents) continue;
    // An earlier refund without a quote retains its original component and period.
    const refunded = refunds.get(p.id) ?? 0;
    if (refunded === p.amountCents) continue;
    const allocation = allocatePayment(p.amountCents-refunded, totals.laborCents-totals.discountCents, totals.partsCents);
    allocations.push({id:p.id, ...allocation, unallocatedCents:refunded});
  }
  if (!allocations.length) return [];
  return [
    stmt(ctx.env.DB, `UPDATE Payment SET laborCents=json_extract(j.value,'$.laborCents'),partsCents=json_extract(j.value,'$.partsCents'),
      unallocatedCents=json_extract(j.value,'$.unallocatedCents') FROM json_each(?) j WHERE Payment.id=json_extract(j.value,'$.id') AND Payment.orderId=?`, [JSON.stringify(allocations),order.id]),
    stmt(ctx.env.DB, "INSERT INTO AuditEvent(id,actorId,action,entityType,entityId,data,createdAt) VALUES(?,?,'PAYMENTS_ALLOCATED','WorkOrder',?,?,?)",
      [uuid(), ctx.actor.id, order.id, JSON.stringify(allocations), now()]),
  ];
}

export function refundAllocation(order: OrderDetail, source: Payment, amount: number): PaymentAllocation {
  const payments = order.payments ?? [];
  const available = {laborCents: source.laborCents, partsCents: source.partsCents, unallocatedCents: source.unallocatedCents};
  for (const refund of payments.filter(p => p.relatedPaymentId === source.id)) {
    available.laborCents -= refund.laborCents;
    available.partsCents -= refund.partsCents;
    available.unallocatedCents -= refund.unallocatedCents;
  }
  if (amount > available.laborCents + available.partsCents + available.unallocatedCents) fail(422, 'Возврат превышает остаток исходного платежа');
  const net = (key: 'laborCents' | 'partsCents') => Number(payments.reduce((sum,p) => sum + (p.kind === 'REFUND' ? -BigInt(p[key]) : BigInt(p[key])), 0n));
  const result = {laborCents:0, partsCents:0, unallocatedCents:0};
  let remaining = amount;
  const take = (key: keyof PaymentAllocation, cap: number) => {
    const used = Math.min(remaining, available[key], Math.max(0, cap));
    result[key] += used; remaining -= used; available[key] -= used;
  };
  // Refund a removed component first, then the rest in a deterministic order.
  take('partsCents', net('partsCents') - order.totals.partsCents);
  take('laborCents', net('laborCents') - (order.totals.laborCents - order.discountCents));
  take('unallocatedCents', remaining);
  take('partsCents', remaining);
  take('laborCents', remaining);
  return result;
}
