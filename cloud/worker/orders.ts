import { z } from 'zod';
import type { Customer, InspectionItem, OrderDetail, OrderLine, Payment, LegacyFinancialSnapshot, Vehicle } from '../shared/types';
import { calculateTotals, MAX_MONEY, MAX_QUANTITY } from '../shared/money';
import { canTransition, isClosed } from '../shared/status';
import { dateFilter, financeCTE } from './overview';
import { assertReviewed, paidFromLedger, pendingAllocations, totalsForOrder } from './finances';
export { totalsForOrder } from './finances';
import { body, fail, json, pagination, requireRole } from './common';
import { all, first, guarded, now, stmt, uuid } from './db';
import type { Context, D1PreparedStatement } from './types';

export const cents = z.number().int().min(0).max(MAX_MONEY);
export const quantity = z.number().int().min(1).max(MAX_QUANTITY);
export const versionField = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const statusField = z.enum(['NEW', 'DIAGNOSTICS', 'APPROVAL', 'IN_PROGRESS', 'READY', 'DELIVERED', 'CANCELLED']);
const variantField = z.enum(['NONE', 'ORIGINAL', 'ANALOG', 'CUSTOM']);
const idField = z.string().min(1).max(200);
const priceKeys = ['laborPriceCents', 'originalPriceCents', 'analogPriceCents', 'customPriceCents'] as const;
type OrderRow = Omit<OrderDetail, 'customer' | 'vehicle' | 'master' | 'inspectionItems' | 'lines' | 'documents' | 'totals'>;

/** Internal scoped snapshot. HTTP callers must use serializeOrder to redact MASTER financials. */
export async function loadOrder(ctx: Context, id: string): Promise<OrderDetail> {
  const db = ctx.env.DB;
  const scoped = ctx.actor.role === 'MASTER';
  const where = ' FROM WorkOrder WHERE id=?' + (scoped ? ' AND masterId=?' : '');
  const args = scoped ? [id, ctx.actor.id] : [id];
  const linked = (column: string) => '(SELECT ' + column + where + ')';
  // The version, ledger and all editable children must describe the same database snapshot.
  const rows = await db.batch([
    stmt(db,'SELECT *'+where,args),
    stmt(db,'SELECT * FROM Customer WHERE id='+linked('customerId'),args),
    stmt(db,'SELECT * FROM Vehicle WHERE id='+linked('vehicleId'),args),
    stmt(db,'SELECT id,name FROM User WHERE id='+linked('masterId'),args),
    stmt(db,'SELECT * FROM InspectionItem WHERE orderId='+linked('id')+' ORDER BY category,id',args),
    stmt(db,'SELECT * FROM OrderLine WHERE orderId='+linked('id')+' ORDER BY id',args),
    stmt(db,'SELECT id,number,kind,version,createdAt,sha256 FROM Document WHERE orderId='+linked('id')+' ORDER BY createdAt DESC,id',args),
    stmt(db,'SELECT * FROM Payment WHERE orderId='+linked('id')+' ORDER BY occurredAt,id',args),
    stmt(db,'SELECT * FROM LegacyFinancialSnapshot WHERE orderId='+linked('id'),args),
  ]);
  const result = <T>(index: number) => rows[index].results as T[];
  const order = result<OrderRow>(0)[0];
  if (!order) fail(404, 'Заказ не найден');
  const customer = result<Customer>(1)[0], vehicle = result<Vehicle>(2)[0];
  const master = result<{id:string;name:string}>(3)[0] ?? null;
  const inspectionItems = result<InspectionItem>(4), rawLines = result<OrderLine>(5);
  const documents = result<OrderDetail['documents'][number]>(6), payments = result<Payment>(7);
  const legacySnapshot = result<LegacyFinancialSnapshot>(8)[0] ?? null;
  const lines = rawLines.map(l => ({...l,completed:!!l.completed}));
  if (!customer || !vehicle) fail(500, 'Нарушена связь заказа с клиентом или автомобилем');
  order.paidCents = paidFromLedger(payments);
  return { ...order, customer, vehicle, master, inspectionItems: inspectionItems.map(x => ({...x, left: !!x.left, right: !!x.right})), lines, documents, payments, legacySnapshot, totals: totalsForOrder({...order, lines, legacySnapshot}) };
}
export function serializeOrder(order: OrderDetail, ctx: Context): OrderDetail {
  if (ctx.actor.role !== 'MASTER') return order;
  return { ...order, customer: {...order.customer,phone:'',phoneNormalized:'',email:null,comment:''} as Customer, vehicle: {...order.vehicle, customerId: '', comment: ''}, discountCents: 0, paidCents: 0,
    inspectionItems: order.inspectionItems.map(x => ({...x, laborPriceCents: 0, originalPriceCents: 0, analogPriceCents: 0, customPriceCents: 0})),
    lines: order.lines.map(x => ({...x, unitPriceCents: 0})), documents: [], payments: [], legacySnapshot: null, totals: calculateTotals([]) };
}
function auditStatement(ctx: Context, id: string, action: string, data: unknown) {
  return stmt(ctx.env.DB, 'INSERT INTO AuditEvent(id,actorId,action,entityType,entityId,data,createdAt) VALUES(?,?,?,?,?,?,?)', [uuid(), ctx.actor.id, action, 'WorkOrder', id, JSON.stringify(data), now()]);
}
function checkMutable(order: OrderDetail, version: number, allowClosed = false) {
  if (order.version !== version) fail(409, 'Заказ изменён другим сотрудником. Обновите данные');
  if (!allowClosed && order.status === 'CANCELLED') fail(409, 'Отменённый заказ нельзя изменять');
}
/** Atomically validates the snapshot, increments the version, writes children and audits. */
export async function mutateOrder(ctx: Context, order: OrderDetail, expectedVersion: number, statements: D1PreparedStatement[], action: string, data: unknown = {}, allowClosed = false): Promise<void> {
  checkMutable(order, expectedVersion, allowClosed);
  const scoped = ctx.actor.role === 'MASTER';
  const sql = 'SELECT COUNT(*) FROM WorkOrder WHERE id = ? AND version = ?' + (scoped ? ' AND masterId = ?' : '') + (allowClosed ? '' : " AND status <> 'CANCELLED'");
  await guarded(ctx.env.DB, sql, scoped ? [order.id, expectedVersion, ctx.actor.id] : [order.id, expectedVersion], [
    stmt(ctx.env.DB, 'UPDATE WorkOrder SET version = version + 1, updatedAt = ? WHERE id = ?', [now(), order.id]),
    ...statements, auditStatement(ctx, order.id, action, data),
  ]);
}
export function createOrderWrites(ctx: Context, id: string, customerId: string, vehicleId: string, mileage: number, complaint: string, masterId: string | null, timestamp: string) {
  const db = ctx.env.DB;
  const number = `ЗН-${new Date().getUTCFullYear()}-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  return [stmt(db, 'INSERT INTO WorkOrder(id,number,customerId,vehicleId,masterId,mileage,complaint,openedAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)', [id, number, customerId, vehicleId, masterId, mileage, complaint, timestamp, timestamp]),
    stmt(db, 'INSERT INTO InspectionItem(id,orderId,catalogItemId,category,name,laborPriceCents,authorId,updatedAt) SELECT lower(hex(randomblob(16))),?,id,category,name,laborPriceCents,?,? FROM CatalogItem WHERE active=1', [id, ctx.actor.id, timestamp]),
    stmt(db, 'UPDATE Vehicle SET mileage=?,updatedAt=? WHERE id=?', [mileage, timestamp, vehicleId]), auditStatement(ctx, id, 'ORDER_CREATED', {number})];
}
const createSchema = z.object({vehicleId: idField, masterId: idField.nullable().optional(), mileage: z.number().int().min(0).max(10000000), complaint: z.string().trim().min(1).max(5000)}).strict();
async function createOrder(ctx: Context) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const input = createSchema.parse(await body(ctx.request));
  const db = ctx.env.DB;
  const vehicle = await first<Vehicle>(db, 'SELECT v.* FROM Vehicle v JOIN Customer c ON c.id=v.customerId WHERE v.id=? AND v.archivedAt IS NULL AND c.archivedAt IS NULL', [input.vehicleId]);
  if (!vehicle) fail(404, 'Активный автомобиль не найден');
  if (input.mileage < vehicle.mileage) fail(422, 'Пробег не может быть меньше последнего зафиксированного');
  if (input.masterId && !await first(db, "SELECT id FROM User WHERE id=? AND role='MASTER' AND active=1", [input.masterId])) fail(422, 'Выберите активного мастера');
  const id = uuid();
  const writes = createOrderWrites(ctx, id, vehicle.customerId, vehicle.id, input.mileage, input.complaint, input.masterId ?? null, now());
  await guarded(db, "SELECT COUNT(*) FROM Vehicle v JOIN Customer c ON c.id=v.customerId WHERE v.id=? AND v.customerId=? AND v.mileage<=? AND v.archivedAt IS NULL AND c.archivedAt IS NULL" + (input.masterId ? " AND EXISTS(SELECT 1 FROM User WHERE id=? AND active=1 AND role='MASTER')" : ''), [vehicle.id, vehicle.customerId, input.mileage, ...(input.masterId ? [input.masterId] : [])], writes);
  return json(await loadOrder(ctx, id), 201);
}
const updateSchema = z.object({version: versionField, status: statusField.optional(), masterId: idField.nullable().optional(), complaint: z.string().trim().min(1).max(5000).optional(), comment: z.string().max(5000).optional(), recommendations: z.string().max(10000).optional(), discountCents: cents.optional(), paidCents: cents.optional()}).strict();
async function updateOrder(ctx: Context, id: string) {
  const {version, ...data} = updateSchema.parse(await body(ctx.request));
  if (ctx.actor.role === 'MASTER' && Object.keys(data).some(k => !['status', 'comment', 'recommendations'].includes(k))) fail(403, 'Мастер не может изменять реквизиты и цены заказа');
  const order = await loadOrder(ctx, id);
  checkMutable(order, version);
  if (data.paidCents !== undefined) fail(422, 'Внесите оплату отдельным платежом');
  if (data.discountCents !== undefined) assertReviewed(order);
  if (data.status === 'DELIVERED') fail(422, 'Используйте выдачу автомобиля с актом');
  if (data.status && !canTransition(order.status, data.status, ctx.actor.role)) fail(422, 'Недопустимый переход статуса');
  if (data.masterId && !await first(ctx.env.DB, "SELECT id FROM User WHERE id=? AND active=1 AND role='MASTER'", [data.masterId])) fail(422, 'Выберите активного мастера');
  const totals = totalsForOrder({...order, ...data});
  if (data.status === 'CANCELLED' && totals.paidCents > 0) fail(422, 'Отмена оплаченного заказа требует урегулирования оплаты');
  const changed: Record<string, unknown> = {...data, ...(data.status && isClosed(data.status) ? {closedAt: now()} : {})};
  const writes: D1PreparedStatement[] = [];
  if (data.masterId) writes.push(stmt(ctx.env.DB, "INSERT INTO MutationGuard(key,ok) VALUES(?,(SELECT COUNT(*) FROM User WHERE id=? AND active=1 AND role='MASTER'))", [id + ':master', data.masterId]), stmt(ctx.env.DB, 'DELETE FROM MutationGuard WHERE key=?', [id + ':master']));
  if (Object.keys(changed).length) writes.push(stmt(ctx.env.DB, `UPDATE WorkOrder SET ${Object.keys(changed).map(k => `${k}=?`).join(',')} WHERE id=?`, [...Object.values(changed), id]));
  if (data.discountCents !== undefined) writes.push(...pendingAllocations(ctx, order, totals));
  await mutateOrder(ctx, order, version, writes, 'ORDER_UPDATED', {before: {status: order.status, discountCents: order.discountCents, paidCents: order.paidCents, masterId: order.masterId}, after: data});
  return json(serializeOrder(await loadOrder(ctx, id), ctx));
}
export const inspectionSchema = z.object({version: versionField, recommendations: z.string().max(10000).optional(), items: z.array(z.object({id: idField, catalogItemId: idField.nullable().optional(), category: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(500), left: z.boolean(), right: z.boolean(), condition: z.enum(['UNCHECKED', 'CHECKED', 'REPAIR', 'RECOMMENDED', 'DONE']), quantityMilli: quantity, laborPriceCents: cents, originalPriceCents: cents, analogPriceCents: cents, customPriceCents: cents, selectedPart: variantField, note: z.string().max(3000)})).max(300)}).strict();
async function updateInspection(ctx: Context, id: string) {
  const input = inspectionSchema.parse(await body(ctx.request));
  const order = await loadOrder(ctx, id);
  checkMutable(order, input.version);
  const existing = new Map(order.inspectionItems.map(x => [x.id, x]));
  if (input.items.length !== existing.size || new Set(input.items.map(x => x.id)).size !== existing.size) fail(422, 'Состав осмотра не совпадает с заказом');
  const writes: D1PreparedStatement[] = [];
  const after: InspectionItem[] = [];
  for (const item of input.items) {
    const old = existing.get(item.id);
    if (!old) fail(422, 'Позиция не принадлежит заказу');
    const {id: itemId, catalogItemId: ignored, ...data} = item;
    void ignored;
    let changed: Record<string, unknown> = data;
    if (ctx.actor.role === 'MASTER') {
      if (item.category !== old.category || item.name !== old.name || item.quantityMilli !== old.quantityMilli || item.selectedPart !== old.selectedPart) fail(403, 'Мастер не может изменять состав и количество');
      if (priceKeys.some(k => item[k] !== 0 && item[k] !== old[k])) fail(403, 'Мастер не может изменять цены');
      changed = {left: item.left, right: item.right, condition: item.condition, note: item.note};
    }
    changed = {...changed, authorId: ctx.actor.id, updatedAt: now()};
    void itemId;
    after.push({...old, ...changed} as InspectionItem);
  }
  const fields = ['category', 'name', 'left', 'right', 'condition', 'quantityMilli', ...priceKeys, 'selectedPart', 'note', 'authorId', 'updatedAt'];
  writes.push(stmt(ctx.env.DB, `UPDATE InspectionItem SET ${fields.map(k => `"${k}"=json_extract(j.value,'$.${k}')`).join(',')} FROM json_each(?) AS j WHERE InspectionItem.id=json_extract(j.value,'$.id') AND InspectionItem.orderId=?`, [JSON.stringify(after), id]));
  if (input.recommendations !== undefined) writes.push(stmt(ctx.env.DB, 'UPDATE WorkOrder SET recommendations=? WHERE id=?', [input.recommendations, id]));
  await mutateOrder(ctx, order, input.version, writes, 'INSPECTION_SAVED', {before: order.inspectionItems, after, recommendations: input.recommendations ?? order.recommendations});
  return json(serializeOrder(await loadOrder(ctx, id), ctx));
}
const transferSchema = z.object({version: versionField, inspectionItemIds: z.array(idField).min(1).max(300)}).strict();
function upsertLines(ctx: Context, orderId: string, lines: OrderLine[]) {
  const fields = ['id', 'inspectionItemId', 'kind', 'name', 'quantityMilli', 'unitPriceCents', 'variant', 'article', 'approval', 'completed', 'partSource'];
  return stmt(ctx.env.DB, `INSERT INTO OrderLine(orderId,${fields.join(',')}) SELECT ?,${fields.map(k => `json_extract(j.value,'$.${k}')`).join(',')} FROM json_each(?) AS j WHERE 1 ON CONFLICT(orderId,inspectionItemId,kind) DO UPDATE SET name=excluded.name,quantityMilli=excluded.quantityMilli,unitPriceCents=excluded.unitPriceCents,variant=excluded.variant,article=excluded.article,approval=excluded.approval,completed=excluded.completed,partSource=excluded.partSource`, [orderId, JSON.stringify(lines)]);
}
function reconcileLine(old: OrderLine | undefined, line: OrderLine): OrderLine {
  const updated = {...line, completed: line.completed ?? old?.completed ?? false, approval: line.approval ?? old?.approval ?? 'PENDING',
    partSource: line.kind === 'LABOR' ? 'SERVICE' as const : line.partSource ?? old?.partSource ?? 'SERVICE'};
  if (old?.approval === 'APPROVED' && (old.unitPriceCents !== updated.unitPriceCents || old.quantityMilli !== updated.quantityMilli ||
      old.kind !== updated.kind || old.variant !== updated.variant || old.partSource !== updated.partSource || old.name !== updated.name || old.article !== updated.article)) updated.approval = 'PENDING';
  return updated;
}
async function transferInspection(ctx: Context, id: string) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const input = transferSchema.parse(await body(ctx.request));
  const order = await loadOrder(ctx, id);
  checkMutable(order, input.version);
  const writes: D1PreparedStatement[] = [];
  assertReviewed(order);
  let lines = [...order.lines];
  for (const itemId of new Set(input.inspectionItemIds)) {
    const item = order.inspectionItems.find(x => x.id === itemId);
    if (!item) fail(422, 'Позиция не принадлежит заказу');
    const add = (kind: 'LABOR' | 'PART', unitPriceCents: number, variant: OrderLine['variant']) => {
      const old = lines.find(x => x.inspectionItemId === itemId && x.kind === kind);
      const line: OrderLine = {id: old?.id ?? uuid(), inspectionItemId: itemId, kind, name: item.name, quantityMilli: item.quantityMilli, unitPriceCents, variant, article: old?.article ?? ''};
      lines = [...lines.filter(x => !(x.inspectionItemId === itemId && x.kind === kind)), reconcileLine(old, line)];

    };
    add('LABOR', item.laborPriceCents, 'NONE');
    if (item.selectedPart !== 'NONE') add('PART', item.selectedPart === 'ORIGINAL' ? item.originalPriceCents : item.selectedPart === 'ANALOG' ? item.analogPriceCents : item.customPriceCents, item.selectedPart);
    else { lines = lines.filter(x => !(x.inspectionItemId === itemId && x.kind === 'PART')); }
  }
  writes.push(...pendingAllocations(ctx, order, totalsForOrder({...order, lines})));
  if (lines.length > 300) fail(422, 'В заказе допускается не более 300 строк');
  const touched = new Set(input.inspectionItemIds);
  const retained = lines.filter(x => x.inspectionItemId && touched.has(x.inspectionItemId));
  const remove = order.lines.filter(x => x.inspectionItemId && touched.has(x.inspectionItemId) && !lines.some(y => y.id === x.id)).map(x => x.id);
  writes.push(stmt(ctx.env.DB, 'DELETE FROM OrderLine WHERE orderId=? AND id IN (SELECT value FROM json_each(?))', [id, JSON.stringify(remove)]), upsertLines(ctx, id, retained));
  await mutateOrder(ctx, order, input.version, writes, 'INSPECTION_TRANSFERRED', {inspectionItemIds: input.inspectionItemIds, before: order.lines, after: lines});
  return json(serializeOrder(await loadOrder(ctx, id), ctx));
}
const linesSchema = z.object({version: versionField, lines: z.array(z.object({id: idField.optional(), kind: z.enum(['LABOR', 'PART']), name: z.string().trim().min(1).max(500), quantityMilli: quantity, unitPriceCents: cents, variant: variantField.default('NONE'), article: z.string().max(120).default(''), approval: z.enum(['PENDING','APPROVED','DEFERRED']).optional(), completed: z.boolean().optional(), partSource: z.enum(['SERVICE','CUSTOMER']).optional()})).max(300)}).strict();
async function updateLines(ctx: Context, id: string) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const input = linesSchema.parse(await body(ctx.request));
  const order = await loadOrder(ctx, id);
  checkMutable(order, input.version);
  assertReviewed(order);
  const ids = input.lines.map(x => x.id).filter((x): x is string => !!x);
  if (new Set(ids).size !== ids.length || ids.some(x => !order.lines.some(y => y.id === x))) fail(422, 'Некорректные идентификаторы строк');
  const lines = input.lines.map(x => {
    const old = order.lines.find(y => y.id === x.id);
    return reconcileLine(old, {...x, id: x.id ?? uuid(), inspectionItemId: old?.inspectionItemId ?? null});
  });
  const linkedKeys = new Set<string>();
  for (const line of lines) {
    if (line.kind === 'LABOR' && line.variant !== 'NONE') fail(422, 'Работа не может иметь вариант запчасти');
    if (line.inspectionItemId) { const key = `${line.inspectionItemId}:${line.kind}`; if (linkedKeys.has(key)) fail(422, 'Две строки с одной привязкой осмотра и видом'); linkedKeys.add(key); }
  }
  // Recreate only this order's editable rows, preserving ids and inspection links.
  const writes = [stmt(ctx.env.DB, 'DELETE FROM OrderLine WHERE orderId=?', [id]), upsertLines(ctx, id, lines)];
  writes.push(...pendingAllocations(ctx,order,totalsForOrder({...order,lines})));
  await mutateOrder(ctx, order, input.version, writes, 'LINES_UPDATED', {before: order.lines, after: lines});
  return json(serializeOrder(await loadOrder(ctx, id), ctx));
}

const joins = ' FROM WorkOrder o JOIN Customer c ON c.id=o.customerId JOIN Vehicle v ON v.id=o.vehicleId LEFT JOIN User m ON m.id=o.masterId JOIN finances f ON f.id=o.id';
const listingSelect = `SELECT o.*, json_object('id',c.id,'kind',c.kind,'name',c.name,'phone',c.phone,'email',c.email,'comment',c.comment,'archivedAt',c.archivedAt) AS customerJson, json_object('id',v.id,'customerId',v.customerId,'make',v.make,'model',v.model,'year',v.year,'vin',v.vin,'plate',v.plate,'mileage',v.mileage,'engine',v.engine,'comment',v.comment,'archivedAt',v.archivedAt) AS vehicleJson, m.name AS masterName,f.paidCents ledgerPaidCents,f.totalCents,f.laborCents,f.partsCents`;
async function orderList(ctx: Context) {
  const {q, page, pageSize} = pagination(ctx.request);
  const status = new URL(ctx.request.url).searchParams.get('status');
  if (status && !statusField.safeParse(status).success) fail(422, 'Неизвестный статус заказа');
  const clauses: string[] = [], args: unknown[] = [];
  if (ctx.actor.role === 'MASTER') {clauses.push('o.masterId=?'); args.push(ctx.actor.id);}
  if (status) {clauses.push('o.status=?'); args.push(status);}
  const dates = dateFilter(ctx.request, 'o.openedAt');
  clauses.push(dates.sql); args.push(...dates.args);
  if (new URL(ctx.request.url).searchParams.get('debtOnly') === '1') {
    requireRole(ctx.actor,'ADMIN','RECEPTION');
    clauses.push("o.status <> 'CANCELLED' AND f.totalCents > f.paidCents");
  }
  if (q) {
    clauses.push('(o.number LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.phoneNormalized LIKE ? OR v.plate LIKE ? OR v.vin LIKE ? OR v.make LIKE ? OR v.model LIKE ?)');
    const pattern = `%${q}%`; args.push(pattern, pattern, pattern, `%${q.replace(/\D/g, '') || q}%`, pattern, pattern, pattern, pattern);
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const count = await first<{total: number}>(ctx.env.DB, financeCTE + ' SELECT COUNT(*) AS total' + joins + where, args);
  const total = count?.total ?? 0;
  const rows = await all<OrderRow & {customerJson: string; vehicleJson: string; masterName: string | null; ledgerPaidCents:number; laborCents: number; partsCents: number; totalCents: number}>(ctx.env.DB, financeCTE + ' ' + listingSelect + joins + where + ' ORDER BY o.openedAt DESC,o.id DESC LIMIT ? OFFSET ?', [...args,pageSize,(page-1)*pageSize]);
  const items = rows.map(({customerJson, vehicleJson, masterName, ledgerPaidCents, laborCents, partsCents, totalCents, ...row}) => {
    row.paidCents = ledgerPaidCents;
    const totals = {laborCents,partsCents,totalCents,subtotalCents:laborCents+partsCents,discountCents:row.discountCents,paidCents:row.paidCents,
      balanceCents:Math.max(0,totalCents-row.paidCents),overpaidCents:Math.max(0,row.paidCents-totalCents)};
    const base = {...row, customer: JSON.parse(customerJson) as Customer, vehicle: JSON.parse(vehicleJson) as Vehicle, master: row.masterId ? {id: row.masterId, name: masterName ?? ''} : null, totals};
    return ctx.actor.role === 'MASTER' ? {...base, customer: {...base.customer,phone:'',phoneNormalized:'',email:null,comment:''}, vehicle: {...base.vehicle, customerId: '', comment: ''}, discountCents: 0, paidCents: 0, totals: calculateTotals([])} : base;
  });
  return {items, total, page, pageSize};
}
export async function handleOrders(ctx: Context): Promise<Response | null> {
  const path = new URL(ctx.request.url).pathname.replace(/\/$/, ''), method = ctx.request.method;
  if (path === '/api/orders/export') return null;
  if (path === '/api/orders') {
    if (method === 'GET') return json(await orderList(ctx));
    if (method === 'POST') return createOrder(ctx);
    return null;
  }
  const match = /^\/api\/orders\/([^/]+)(?:\/(inspection|lines|transfer|review-finances))?$/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (!match[2] && method === 'GET') return json(serializeOrder(await loadOrder(ctx, id), ctx));
  if (!match[2] && method === 'PATCH') return updateOrder(ctx, id);
  if (match[2] === 'review-finances' && method === 'POST') {
    requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
    const input = z.strictObject({
      version:versionField, discountCents:cents.default(0),
      decisions:z.array(z.strictObject({id:idField, approval:z.enum(['PENDING','APPROVED','DEFERRED']),
        completed:z.boolean(), partSource:z.enum(['SERVICE','CUSTOMER']).default('SERVICE')})).max(300).default([]),
    }).parse(await body(ctx.request));
    const order = await loadOrder(ctx,id);
    if (order.financialMode !== 'LEGACY') fail(409,'Расчёт уже проверен');
    const decisions = new Map(input.decisions.map(d=>[d.id,d]));
    if (decisions.size !== input.decisions.length || input.decisions.some(d=>!order.lines.some(l=>l.id===d.id)))
      fail(422,'Некорректные идентификаторы строк');
    const lines = order.lines.map(line=>({...line,...decisions.get(line.id!)}));
    const totals = totalsForOrder({...order,financialMode:'WORKFLOW',lines,discountCents:input.discountCents});
    const writes = [
      stmt(ctx.env.DB,"UPDATE WorkOrder SET financialMode='WORKFLOW',discountCents=? WHERE id=?",[input.discountCents,id]),
      stmt(ctx.env.DB,`UPDATE OrderLine SET approval=json_extract(d.value,'$.approval'),completed=json_extract(d.value,'$.completed'),
        partSource=CASE WHEN kind='LABOR' THEN 'SERVICE' ELSE json_extract(d.value,'$.partSource') END
        FROM json_each(?) d WHERE orderId=? AND OrderLine.id=json_extract(d.value,'$.id')`,[JSON.stringify(input.decisions),id]),
      ...pendingAllocations(ctx,order,totals),
    ];
    await mutateOrder(ctx,order,input.version,writes,'FINANCES_REVIEWED',{previous:order.legacySnapshot,decisions:input.decisions,totals});
    return json(await loadOrder(ctx,id));
  }
  if (match[2] === 'inspection' && method === 'PUT') return updateInspection(ctx, id);
  if (match[2] === 'lines' && method === 'PUT') return updateLines(ctx, id);
  if (match[2] === 'transfer' && method === 'POST') return transferInspection(ctx, id);
  return null;
}
