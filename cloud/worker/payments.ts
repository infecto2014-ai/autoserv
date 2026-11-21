import {z} from 'zod';
import {allocatePayment} from '../shared/workflow-money';
import {body, fail, requireRole} from './common';
import {now, stmt, uuid} from './db';
import {refundAllocation} from './finances';
import {cents, loadOrder, mutateOrder, versionField} from './orders';
import {requestIdField, withRequest} from './workflow-request';
import type {Context} from './types';

const base = {version:versionField, requestId:requestIdField, amountCents:cents.positive()};
const schema = z.union([
  z.strictObject({...base, kind:z.literal('PAYMENT').default('PAYMENT')}),
  z.strictObject({...base, kind:z.literal('REFUND'), relatedPaymentId:requestIdField, reason:z.string().trim().min(1).max(1000)}),
]);
export async function postPayment(ctx: Context, id: string) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const input = schema.parse(await body(ctx.request));
  return withRequest(ctx,'PAYMENT',input.requestId,{orderId:id,...input},async record => {
    const order = await loadOrder(ctx,id);
    if (order.version !== input.version) fail(409,'Заказ изменён. Обновите данные');
    const paid = order.paidCents + (input.kind === 'REFUND' ? -input.amountCents : input.amountCents);
    if (!Number.isSafeInteger(paid) || paid < 0) fail(422,'Недопустимый остаток оплаты');
    let allocation, related: string | null = null, reason: string | null = null;
    if (input.kind === 'REFUND') {
      const source = order.payments?.find(p => p.id === input.relatedPaymentId && p.kind !== 'REFUND');
      if (!source) fail(422,'Исходный платёж не найден в заказе');
      allocation = refundAllocation(order,source,input.amountCents);
      related = source.id; reason = input.reason;
    } else {
      const t = order.totals;
      allocation = order.financialMode === 'LEGACY'
        ? {laborCents:0, partsCents:0, unallocatedCents:input.amountCents}
        : allocatePayment(input.amountCents, t.laborCents-t.discountCents, t.partsCents);
    }
    const paymentId = uuid(), db = ctx.env.DB;
    await mutateOrder(ctx,order,input.version,[
      stmt(db,'INSERT INTO Payment(id,orderId,kind,amountCents,laborCents,partsCents,unallocatedCents,occurredAt,actorId,relatedPaymentId,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [paymentId,id,input.kind,input.amountCents,allocation.laborCents,allocation.partsCents,allocation.unallocatedCents,now(),ctx.actor.id,related,reason]),
      stmt(db,'UPDATE WorkOrder SET paidCents=? WHERE id=?',[paid,id]), record(id,paymentId),
    ], input.kind === 'REFUND' ? 'PAYMENT_REFUNDED' : 'PAYMENT_RECEIVED', {paymentId,...input,...allocation});
    return id;
  });
}
