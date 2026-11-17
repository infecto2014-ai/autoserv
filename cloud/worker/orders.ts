import { z } from 'zod';
import type { Customer, InspectionItem, OrderDetail, OrderLine, OrderStatus, Vehicle } from '../shared/types';
import { calculateTotals, MAX_MONEY, MAX_QUANTITY } from '../shared/money';
import { canTransition, isClosed, STATUS_LABELS } from '../shared/status';
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

export function totalsForOrder(order: Pick<OrderDetail, 'lines' | 'discountCents' | 'paidCents'>) {
  try { return calculateTotals(order.lines, order.discountCents, order.paidCents); }
  catch (error) { fail(422, error instanceof Error ? error.message : 'Ошибка расчёта'); }
}

/** Internal scoped snapshot. HTTP callers must use serializeOrder to redact MASTER financials. */
export async function loadOrder(ctx: Context, id: string): Promise<OrderDetail> {
  const db = ctx.env.DB;
  const scoped = ctx.actor.role === 'MASTER';
  const order = await first<OrderRow>(db, 'SELECT * FROM WorkOrder WHERE id = ?' + (scoped ? ' AND masterId = ?' : ''), scoped ? [id, ctx.actor.id] : [id]);
  if (!order) fail(404, 'Заказ не найден');
  const [customer, vehicle, master, inspectionItems, lines, documents] = await Promise.all([
    first<Customer>(db, 'SELECT * FROM Customer WHERE id = ?', [order.customerId]),
    first<Vehicle>(db, 'SELECT * FROM Vehicle WHERE id = ?', [order.vehicleId]),
    order.masterId ? first<{id: string; name: string}>(db, 'SELECT id,name FROM User WHERE id = ?', [order.masterId]) : Promise.resolve(null),
    all<InspectionItem>(db, 'SELECT * FROM InspectionItem WHERE orderId = ? ORDER BY category,id', [id]),
    all<OrderLine>(db, 'SELECT * FROM OrderLine WHERE orderId = ? ORDER BY id', [id]),
    all<OrderDetail['documents'][number]>(db, 'SELECT id,number,kind,version,createdAt,sha256 FROM Document WHERE orderId = ? ORDER BY createdAt DESC,id', [id]),
  ]);
  if (!customer || !vehicle) fail(500, 'Нарушена связь заказа с клиентом или автомобилем');
  return { ...order, customer, vehicle, master, inspectionItems: inspectionItems.map(x => ({...x, left: !!x.left, right: !!x.right})), lines, documents, totals: totalsForOrder({...order, lines}) };
}
export function serializeOrder(order: OrderDetail, ctx: Context): OrderDetail {
  if (ctx.actor.role !== 'MASTER') return order;
  return { ...order, vehicle: {...order.vehicle, customerId: '', comment: ''}, discountCents: 0, paidCents: 0,
    inspectionItems: order.inspectionItems.map(x => ({...x, laborPriceCents: 0, originalPriceCents: 0, analogPriceCents: 0, customPriceCents: 0})),
    lines: order.lines.map(x => ({...x, unitPriceCents: 0})), documents: [], totals: calculateTotals([]) };
}
function auditStatement(ctx: Context, id: string, action: string, data: unknown) {
  return stmt(ctx.env.DB, 'INSERT INTO AuditEvent(id,actorId,action,entityType,entityId,data,createdAt) VALUES(?,?,?,?,?,?,?)', [uuid(), ctx.actor.id, action, 'WorkOrder', id, JSON.stringify(data), now()]);
}
function checkMutable(order: OrderDetail, version: number, allowClosed = false) {
  if (order.version !== version) fail(409, 'Заказ изменён другим сотрудником. Обновите данные');
  if (!allowClosed && isClosed(order.status)) fail(409, 'Выданный или отменённый заказ нельзя изменять');
}
/** Atomically validates the snapshot, increments the version, writes children and audits. */
export async function mutateOrder(ctx: Context, order: OrderDetail, expectedVersion: number, statements: D1PreparedStatement[], action: string, data: unknown = {}, allowClosed = false): Promise<void> {
  checkMutable(order, expectedVersion, allowClosed);
  const scoped = ctx.actor.role === 'MASTER';
  const sql = 'SELECT COUNT(*) FROM WorkOrder WHERE id = ? AND version = ?' + (scoped ? ' AND masterId = ?' : '') + (allowClosed ? '' : " AND status NOT IN ('DELIVERED','CANCELLED')");
  await guarded(ctx.env.DB, sql, scoped ? [order.id, expectedVersion, ctx.actor.id] : [order.id, expectedVersion], [
    stmt(ctx.env.DB, 'UPDATE WorkOrder SET version = version + 1, updatedAt = ? WHERE id = ?', [now(), order.id]),
    ...statements, auditStatement(ctx, order.id, action, data),
  ]);
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
  const id = uuid(), timestamp = now(), number = `ЗН-${new Date().getUTCFullYear()}-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const writes = [stmt(db, 'INSERT INTO WorkOrder(id,number,customerId,vehicleId,masterId,mileage,complaint,openedAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)', [id, number, vehicle.customerId, vehicle.id, input.masterId ?? null, input.mileage, input.complaint, timestamp, timestamp]),
    stmt(db, 'INSERT INTO InspectionItem(id,orderId,catalogItemId,category,name,laborPriceCents,authorId,updatedAt) SELECT lower(hex(randomblob(16))),?,id,category,name,laborPriceCents,?,? FROM CatalogItem WHERE active=1', [id, ctx.actor.id, timestamp]),
    stmt(db, 'UPDATE Vehicle SET mileage=?,updatedAt=? WHERE id=?', [input.mileage, timestamp, vehicle.id]), auditStatement(ctx, id, 'ORDER_CREATED', {number})];
  await guarded(db, "SELECT COUNT(*) FROM Vehicle v JOIN Customer c ON c.id=v.customerId WHERE v.id=? AND v.customerId=? AND v.mileage<=? AND v.archivedAt IS NULL AND c.archivedAt IS NULL" + (input.masterId ? " AND EXISTS(SELECT 1 FROM User WHERE id=? AND active=1 AND role='MASTER')" : ''), [vehicle.id, vehicle.customerId, input.mileage, ...(input.masterId ? [input.masterId] : [])], writes);
  return json(await loadOrder(ctx, id), 201);
}
const updateSchema = z.object({version: versionField, status: statusField.optional(), masterId: idField.nullable().optional(), complaint: z.string().trim().min(1).max(5000).optional(), comment: z.string().max(5000).optional(), recommendations: z.string().max(10000).optional(), discountCents: cents.optional(), paidCents: cents.optional()}).strict();
async function updateOrder(ctx: Context, id: string) {
  const {version, ...data} = updateSchema.parse(await body(ctx.request));
  if (ctx.actor.role === 'MASTER' && Object.keys(data).some(k => !['status', 'comment', 'recommendations'].includes(k))) fail(403, 'Мастер не может изменять реквизиты и цены заказа');
  const order = await loadOrder(ctx, id);
  checkMutable(order, version);
  if (data.status && !canTransition(order.status, data.status, ctx.actor.role)) fail(422, 'Недопустимый переход статуса');
  if (data.masterId && !await first(ctx.env.DB, "SELECT id FROM User WHERE id=? AND active=1 AND role='MASTER'", [data.masterId])) fail(422, 'Выберите активного мастера');
  const totals = totalsForOrder({...order, ...data});
  if (data.status === 'DELIVERED' && totals.balanceCents !== 0) fail(422, 'Перед выдачей отметьте полную оплату');
  if (data.status === 'CANCELLED' && totals.paidCents > 0) fail(422, 'Отмена оплаченного заказа требует урегулирования оплаты');
  const changed: Record<string, unknown> = {...data, ...(data.status && isClosed(data.status) ? {closedAt: now()} : {})};
  const writes: D1PreparedStatement[] = [];
  if (data.masterId) writes.push(stmt(ctx.env.DB, "INSERT INTO MutationGuard(key,ok) VALUES(?,(SELECT COUNT(*) FROM User WHERE id=? AND active=1 AND role='MASTER'))", [id + ':master', data.masterId]), stmt(ctx.env.DB, 'DELETE FROM MutationGuard WHERE key=?', [id + ':master']));
  if (Object.keys(changed).length) writes.push(stmt(ctx.env.DB, `UPDATE WorkOrder SET ${Object.keys(changed).map(k => `${k}=?`).join(',')} WHERE id=?`, [...Object.values(changed), id]));
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
  const fields = ['id', 'inspectionItemId', 'kind', 'name', 'quantityMilli', 'unitPriceCents', 'variant', 'article'];
  return stmt(ctx.env.DB, `INSERT INTO OrderLine(orderId,${fields.join(',')}) SELECT ?,${fields.map(k => `json_extract(j.value,'$.${k}')`).join(',')} FROM json_each(?) AS j WHERE 1 ON CONFLICT(orderId,inspectionItemId,kind) DO UPDATE SET name=excluded.name,quantityMilli=excluded.quantityMilli,unitPriceCents=excluded.unitPriceCents,variant=excluded.variant,article=excluded.article`, [orderId, JSON.stringify(lines)]);
}
async function transferInspection(ctx: Context, id: string) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const input = transferSchema.parse(await body(ctx.request));
  const order = await loadOrder(ctx, id);
  checkMutable(order, input.version);
  const writes: D1PreparedStatement[] = [];
  let lines = [...order.lines];
  for (const itemId of new Set(input.inspectionItemIds)) {
    const item = order.inspectionItems.find(x => x.id === itemId);
    if (!item) fail(422, 'Позиция не принадлежит заказу');
    const add = (kind: 'LABOR' | 'PART', unitPriceCents: number, variant: OrderLine['variant']) => {
      const old = lines.find(x => x.inspectionItemId === itemId && x.kind === kind);
      const line: OrderLine = {id: old?.id ?? uuid(), inspectionItemId: itemId, kind, name: item.name, quantityMilli: item.quantityMilli, unitPriceCents, variant, article: old?.article ?? ''};
      lines = [...lines.filter(x => !(x.inspectionItemId === itemId && x.kind === kind)), line];

    };
    add('LABOR', item.laborPriceCents, 'NONE');
    if (item.selectedPart !== 'NONE') add('PART', item.selectedPart === 'ORIGINAL' ? item.originalPriceCents : item.selectedPart === 'ANALOG' ? item.analogPriceCents : item.customPriceCents, item.selectedPart);
    else { lines = lines.filter(x => !(x.inspectionItemId === itemId && x.kind === 'PART')); }
  }
  totalsForOrder({...order, lines});
  if (lines.length > 300) fail(422, 'В заказе допускается не более 300 строк');
  const touched = new Set(input.inspectionItemIds);
  const retained = lines.filter(x => x.inspectionItemId && touched.has(x.inspectionItemId));
  const remove = order.lines.filter(x => x.inspectionItemId && touched.has(x.inspectionItemId) && !lines.some(y => y.id === x.id)).map(x => x.id);
  writes.push(stmt(ctx.env.DB, 'DELETE FROM OrderLine WHERE orderId=? AND id IN (SELECT value FROM json_each(?))', [id, JSON.stringify(remove)]), upsertLines(ctx, id, retained));
  await mutateOrder(ctx, order, input.version, writes, 'INSPECTION_TRANSFERRED', {inspectionItemIds: input.inspectionItemIds, before: order.lines, after: lines});
  return json(serializeOrder(await loadOrder(ctx, id), ctx));
}
const linesSchema = z.object({version: versionField, lines: z.array(z.object({id: idField.optional(), kind: z.enum(['LABOR', 'PART']), name: z.string().trim().min(1).max(500), quantityMilli: quantity, unitPriceCents: cents, variant: variantField.default('NONE'), article: z.string().max(120).default('')})).max(300)}).strict();
async function updateLines(ctx: Context, id: string) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const input = linesSchema.parse(await body(ctx.request));
  const order = await loadOrder(ctx, id);
  checkMutable(order, input.version);
  totalsForOrder({...order, lines: input.lines});
  const ids = input.lines.map(x => x.id).filter((x): x is string => !!x);
  if (new Set(ids).size !== ids.length || ids.some(x => !order.lines.some(y => y.id === x))) fail(422, 'Некорректные идентификаторы строк');
  const lines = input.lines.map(x => ({...x, id: x.id ?? uuid(), inspectionItemId: order.lines.find(y => y.id === x.id)?.inspectionItemId ?? null}));
  const linkedKeys = new Set<string>();
  for (const line of lines) {
    if (line.kind === 'LABOR' && line.variant !== 'NONE') fail(422, 'Работа не может иметь вариант запчасти');
    if (line.inspectionItemId) { const key = `${line.inspectionItemId}:${line.kind}`; if (linkedKeys.has(key)) fail(422, 'Две строки с одной привязкой осмотра и видом'); linkedKeys.add(key); }
  }
  // Recreate only this order's editable rows, preserving ids and inspection links.
  const writes = [stmt(ctx.env.DB, 'DELETE FROM OrderLine WHERE orderId=?', [id]), upsertLines(ctx, id, lines)];
  await mutateOrder(ctx, order, input.version, writes, 'LINES_UPDATED', {before: order.lines, after: lines});
  return json(serializeOrder(await loadOrder(ctx, id), ctx));
}

const joins = ' FROM WorkOrder o JOIN Customer c ON c.id=o.customerId JOIN Vehicle v ON v.id=o.vehicleId LEFT JOIN User m ON m.id=o.masterId';
const listingSelect = `SELECT o.*, json_object('id',c.id,'kind',c.kind,'name',c.name,'phone',c.phone,'email',c.email,'comment',c.comment,'archivedAt',c.archivedAt) AS customerJson, json_object('id',v.id,'customerId',v.customerId,'make',v.make,'model',v.model,'year',v.year,'vin',v.vin,'plate',v.plate,'mileage',v.mileage,'engine',v.engine,'comment',v.comment,'archivedAt',v.archivedAt) AS vehicleJson, m.name AS masterName`;
async function orderList(ctx: Context, exporting = false) {
  const {q, page, pageSize} = pagination(ctx.request);
  const status = new URL(ctx.request.url).searchParams.get('status');
  if (status && !statusField.safeParse(status).success) fail(422, 'Неизвестный статус заказа');
  const clauses: string[] = [], args: unknown[] = [];
  if (ctx.actor.role === 'MASTER') {clauses.push('o.masterId=?'); args.push(ctx.actor.id);}
  if (status) {clauses.push('o.status=?'); args.push(status);}
  if (q) {
    clauses.push('(o.number LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.phoneNormalized LIKE ? OR v.plate LIKE ? OR v.vin LIKE ? OR v.make LIKE ? OR v.model LIKE ?)');
    const pattern = `%${q}%`; args.push(pattern, pattern, pattern, `%${q.replace(/\D/g, '') || q}%`, pattern, pattern, pattern, pattern);
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const count = await first<{total: number}>(ctx.env.DB, 'SELECT COUNT(*) AS total' + joins + where, args);
  const total = count?.total ?? 0;
  if (exporting && total > 10000) fail(422, 'Для экспорта выберите не более 10000 заказов с помощью фильтра');
  const rows = await all<OrderRow & {customerJson: string; vehicleJson: string; masterName: string | null}>(ctx.env.DB, listingSelect + joins + where + ' ORDER BY o.openedAt DESC,o.id DESC LIMIT ? OFFSET ?', [...args, exporting ? 10000 : pageSize, exporting ? 0 : (page - 1) * pageSize]);
  const byOrder = new Map<string, OrderLine[]>();
  if (rows.length) {
    // SQLite's signed 64-bit integers exactly hold our maximum quantity × cents (10^17).
    // Aggregate before returning rows, so a 10,000-order CSV remains a constant number of D1 queries.
    const totals = await all<{orderId: string; laborCents: number; partsCents: number}>(ctx.env.DB, `SELECT orderId,
      SUM(CASE WHEN kind='LABOR' THEN (quantityMilli*unitPriceCents+500)/1000 ELSE 0 END) AS laborCents,
      SUM(CASE WHEN kind='PART' THEN (quantityMilli*unitPriceCents+500)/1000 ELSE 0 END) AS partsCents
      FROM OrderLine WHERE orderId IN (SELECT value FROM json_each(?)) GROUP BY orderId`, [JSON.stringify(rows.map(x => x.id))]);
    for (const total of totals) byOrder.set(total.orderId, [
      {kind: 'LABOR', name: '', quantityMilli: 1000, unitPriceCents: total.laborCents, variant: 'NONE', article: ''},
      {kind: 'PART', name: '', quantityMilli: 1000, unitPriceCents: total.partsCents, variant: 'NONE', article: ''},
    ]);
  }
  const items = rows.map(({customerJson, vehicleJson, masterName, ...row}) => {
    const base = {...row, customer: JSON.parse(customerJson) as Customer, vehicle: JSON.parse(vehicleJson) as Vehicle, master: row.masterId ? {id: row.masterId, name: masterName ?? ''} : null, totals: totalsForOrder({...row, lines: byOrder.get(row.id) ?? []})};
    return ctx.actor.role === 'MASTER' ? {...base, vehicle: {...base.vehicle, customerId: '', comment: ''}, discountCents: 0, paidCents: 0, totals: calculateTotals([])} : base;
  });
  return {items, total, page, pageSize};
}
async function exportOrders(ctx: Context) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const {items} = await orderList(ctx, true);
  const cell = (value: unknown) => { const text = String(value ?? ''); return '"' + (/^[\s\u0000-\u001f]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; };
  const rows: unknown[][] = [['Номер', 'Открыт', 'Статус', 'Клиент', 'Телефон', 'Автомобиль', 'Госномер', 'VIN', 'Мастер', 'Пробег', 'Работы, коп.', 'Запчасти, коп.', 'Скидка, коп.', 'Итого, коп.', 'Оплачено, коп.', 'Остаток, коп.'], ...items.map(x => [x.number, x.openedAt, STATUS_LABELS[x.status as OrderStatus], x.customer.name, x.customer.phone, `${x.vehicle.make} ${x.vehicle.model}`, x.vehicle.plate, x.vehicle.vin, x.master?.name ?? '', x.mileage, x.totals.laborCents, x.totals.partsCents, x.discountCents, x.totals.totalCents, x.paidCents, x.totals.balanceCents])];
  return new Response('\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n'), {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="orders.csv"', 'cache-control': 'no-store'}});
}
export async function handleOrders(ctx: Context): Promise<Response | null> {
  const path = new URL(ctx.request.url).pathname.replace(/\/$/, ''), method = ctx.request.method;
  if (path === '/api/orders/export' && method === 'GET') return exportOrders(ctx);
  if (path === '/api/orders') {
    if (method === 'GET') return json(await orderList(ctx));
    if (method === 'POST') return createOrder(ctx);
    return null;
  }
  const match = /^\/api\/orders\/([^/]+)(?:\/(inspection|lines|transfer))?$/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (!match[2] && method === 'GET') return json(serializeOrder(await loadOrder(ctx, id), ctx));
  if (!match[2] && method === 'PATCH') return updateOrder(ctx, id);
  if (match[2] === 'inspection' && method === 'PUT') return updateInspection(ctx, id);
  if (match[2] === 'lines' && method === 'PUT') return updateLines(ctx, id);
  if (match[2] === 'transfer' && method === 'POST') return transferInspection(ctx, id);
  return null;
}
