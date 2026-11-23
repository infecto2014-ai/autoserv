import {fail, json, requireRole} from './common';
import {stmt} from './db';
import type {Context} from './types';

// All order lists and dashboard debts use identical eligible rows and rounding.
export const financeCTE = `WITH prices AS (
  SELECT l.orderId,
    SUM(CASE WHEN l.kind='LABOR' THEN (l.quantityMilli*l.unitPriceCents+500)/1000 ELSE 0 END) laborCents,
    SUM(CASE WHEN l.kind='PART' AND l.partSource='SERVICE' THEN (l.quantityMilli*l.unitPriceCents+500)/1000 ELSE 0 END) partsCents
  FROM OrderLine l JOIN WorkOrder w ON w.id=l.orderId
  WHERE w.financialMode='WORKFLOW' AND l.approval='APPROVED' AND (w.status<>'DELIVERED' OR l.completed=1)
  GROUP BY l.orderId
), ledger AS (
  SELECT orderId,SUM(CASE WHEN kind='REFUND' THEN -amountCents ELSE amountCents END) paidCents FROM Payment GROUP BY orderId
), finances AS (
  SELECT w.id,coalesce(ledger.paidCents,0) paidCents,
    CASE WHEN w.financialMode='LEGACY' THEN s.laborCents ELSE coalesce(p.laborCents,0) END laborCents,
    CASE WHEN w.financialMode='LEGACY' THEN s.partsCents ELSE coalesce(p.partsCents,0) END partsCents,
    CASE WHEN w.financialMode='LEGACY' THEN s.totalCents ELSE coalesce(p.laborCents,0)+coalesce(p.partsCents,0)-w.discountCents END totalCents
  FROM WorkOrder w LEFT JOIN ledger ON ledger.orderId=w.id LEFT JOIN prices p ON p.orderId=w.id LEFT JOIN LegacyFinancialSnapshot s ON s.orderId=w.id
)`;

export function dateFilter(request: Request, column: string) {
  const params = new URL(request.url).searchParams, clauses: string[] = [], args: string[] = [];
  const from = params.get('from'), to = params.get('to');
  for (const [day, last] of [[from,false],[to,true]] as const) {
    if (day === null) continue;
    const utc = Date.parse(day + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(utc) || new Date(utc).toISOString().slice(0,10) !== day)
      fail(422, 'Укажите календарную дату в формате ГГГГ-ММ-ДД');
    const boundary = utc - 2 * 3600000 + (last ? 86400000 : 0);
    clauses.push(column + (last ? '<?' : '>=?')); args.push(new Date(boundary).toISOString());
  }
  if (from && to && from > to) fail(422,'Начало периода позже окончания');
  return {sql:clauses.join(' AND ') || '1',args};
}
export async function overview(ctx: Context) {
  requireRole(ctx.actor,'ADMIN','RECEPTION');
  const closed = dateFilter(ctx.request,'w.closedAt'), paid = dateFilter(ctx.request,'occurredAt');
  const db = ctx.env.DB;
  const countsQuery = stmt(db, financeCTE + `
    SELECT COUNT(CASE WHEN w.status IN ('NEW','DIAGNOSTICS','IN_PROGRESS') THEN 1 END) active,
      COUNT(CASE WHEN w.status='APPROVAL' THEN 1 END) approval, COUNT(CASE WHEN w.status='READY' THEN 1 END) ready,
      COUNT(CASE WHEN w.status='DELIVERED' AND ${closed.sql} THEN 1 END) completed,
      coalesce(SUM(CASE WHEN w.status<>'CANCELLED' THEN max(0,f.totalCents-f.paidCents) ELSE 0 END),0) debtCents
    FROM WorkOrder w JOIN finances f ON f.id=w.id`, closed.args);
  const fields = ['laborCents','partsCents','unallocatedCents','amountCents'];
  const moneyQuery = stmt(db, 'SELECT ' + fields.map(field =>
    `coalesce(SUM(CASE WHEN kind='REFUND' THEN -${field} ELSE ${field} END),0) AS ${field === 'amountCents' ? 'totalCents' : field}`).join(',') +
    ' FROM Payment WHERE ' + paid.sql, paid.args);
  const [countRows, moneyRows] = await db.batch<Record<string,number>>([countsQuery, moneyQuery]);
  const counts = countRows.results[0], money = moneyRows.results[0];
  if (!counts || !money || !Object.values({...counts,...money}).every(Number.isSafeInteger)) fail(422,'Сумма за период превышает допустимую точность');
  const {debtCents,...groups} = counts;
  return json({counts:groups,money:{...money,debtCents}});
}
