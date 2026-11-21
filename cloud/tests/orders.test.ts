import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, OrderDetail } from '../shared/types';
import { handleOrders, loadOrder, mutateOrder } from '../worker/orders';
import { stmt } from '../worker/db';
import type { Context } from '../worker/types';
import { SQLiteD1 } from './sqlite-adapter';

const admin: Actor = {id: 'admin', name: 'Администратор', email: 'a@example.test', role: 'ADMIN'};
const master: Actor = {id: 'master', name: 'Мастер', email: 'm@example.test', role: 'MASTER'};
const other: Actor = {id: 'other', name: 'Другой', email: 'o@example.test', role: 'MASTER'};
let db: SQLiteD1;
function context(method: string, path: string, data?: unknown, actor = admin): Context {
  return {env: {DB: db}, actor, params: {}, request: new Request('https://crm.example.test/api' + path, {method, ...(data === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(data)})})};
}
async function call<T = OrderDetail>(method: string, path: string, data?: unknown, actor = admin): Promise<T> {
  const response = await handleOrders(context(method, path, data, actor));
  if (!response) throw new Error('Route not handled: ' + path);
  return response.json() as Promise<T>;
}
async function create(actor = admin) { return call('POST', '/orders', {vehicleId: 'vehicle', masterId: 'master', mileage: 100, complaint: 'Стук спереди'}, actor); }
function count(table: string) { return Number((db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n); }
beforeEach(() => {
  db = new SQLiteD1();
  for (const user of [admin, master, other]) db.sqlite.prepare('INSERT INTO User(id,name,email,role) VALUES(?,?,?,?)').run(user.id, user.name, user.email, user.role);
  db.sqlite.exec("INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES('customer','Иван Петров','+7 900 1234567','79001234567'); INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES('new-owner','Новый владелец','+7 900 7654321','79007654321'); INSERT INTO Vehicle(id,customerId,make,model,mileage,plate,vin,comment) VALUES('vehicle','customer','Lada','Vesta',90,'А123БВ','VINTEST','Секрет нового владельца')");
  for (let i = 0; i < 110; i++) db.sqlite.prepare('INSERT INTO CatalogItem(id,category,name,laborPriceCents,sortOrder) VALUES(?,?,?,?,?)').run('cat-' + i, 'ТО-1', 'Работа ' + i, i === 0 ? 12345 : 0, i);
  db.sqlite.exec("INSERT INTO CatalogItem(id,category,name,active) VALUES('inactive','Архив','Не копировать',0)");
});
afterEach(() => db.close());

describe('D1 orders on real SQLite', () => {
  it('creates all 110 active inspection copies and persists mileage and audit atomically', async () => {
    const order = await create();
    expect(order.inspectionItems).toHaveLength(110);
    expect(order.customerId).toBe('customer');
    expect(order.inspectionItems.every(x => typeof x.left === 'boolean' && !x.left && x.condition === 'UNCHECKED')).toBe(true);
    expect(order.totals.totalCents).toBe(0);
    expect(order.vehicle.mileage).toBe(100);
    expect(count('AuditEvent')).toBe(1);
    await expect(call('POST', '/orders', {vehicleId: 'vehicle', mileage: 99, complaint: 'Новый'})).rejects.toMatchObject({status: 422});
    expect(count('WorkOrder')).toBe(1);
    expect(count('MutationGuard')).toBe(0);
    const second = await create();
    expect(second.number).not.toBe(order.number);
  });

  it('transfers exact rounded labor and only the selected part, idempotently preserving row IDs', async () => {
    let order = await create();
    const target = order.inspectionItems.find(x => x.catalogItemId === 'cat-0')!;
    const items = order.inspectionItems.map(x => x.id === target.id ? {...x, condition: 'REPAIR', quantityMilli: 1500, originalPriceCents: 70001, analogPriceCents: 20001, selectedPart: 'ANALOG'} : x);
    order = await call('PUT', `/orders/${order.id}/inspection`, {version: order.version, items, recommendations: 'Заменить'});
    order = await call('POST', `/orders/${order.id}/transfer`, {version: order.version, inspectionItemIds: [target.id, target.id]});
    expect(order.lines).toHaveLength(2);
    expect(order.totals.totalCents).toBe(0);
    order = await call('PUT', `/orders/${order.id}/lines`, {version:order.version,lines:order.lines.map(l=>({...l,approval:'APPROVED'}))});
    expect(order.totals).toMatchObject({laborCents: 18518, partsCents: 30002, totalCents: 48520});
    const listed = await call<{items: OrderDetail[]}>('GET', '/orders');
    expect(listed.items[0].totals).toEqual(order.totals);
    expect(order.lines.find(x => x.kind === 'PART')).toMatchObject({variant: 'ANALOG', unitPriceCents: 20001});
    const ids = order.lines.map(x => x.id).sort();
    order = await call('POST', `/orders/${order.id}/transfer`, {version: order.version, inspectionItemIds: [target.id]});
    expect(order.lines.map(x => x.id).sort()).toEqual(ids);
    order = await call('PUT', `/orders/${order.id}/inspection`, {version: order.version, items: order.inspectionItems.map(x => x.id === target.id ? {...x, selectedPart: 'NONE'} : x)});
    order = await call('POST', `/orders/${order.id}/transfer`, {version: order.version, inspectionItemIds: [target.id]});
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].id).toBe(ids.find(id => order.lines[0].id === id));
    expect(order.totals.partsCents).toBe(0);
    const audits = db.sqlite.prepare("SELECT data FROM AuditEvent WHERE action='INSPECTION_TRANSFERRED'").all() as {data: string}[];
    expect(JSON.parse(audits[0].data)).toMatchObject({before: [], after: expect.any(Array)});
  });

  it('allows manual edits while preserving transfer links and rejects duplicates, invalid variants and overflow', async () => {
    let order = await create();
    const target = order.inspectionItems.find(x => x.catalogItemId === 'cat-0')!;
    order = await call('POST', `/orders/${order.id}/transfer`, {version: order.version, inspectionItemIds: [target.id]});
    order = await call('PUT', `/orders/${order.id}/lines`, {version: order.version, lines: [{...order.lines[0], quantityMilli: 2000}, {kind: 'PART', name: 'Масло', quantityMilli: 1000, unitPriceCents: 40000}]});
    expect(order.lines.find(x => x.kind === 'LABOR')?.inspectionItemId).toBe(target.id);
    expect(order.totals.totalCents).toBe(0);
    order = await call('PUT', `/orders/${order.id}/lines`, {version:order.version,lines:order.lines.map(l=>({...l,approval:'APPROVED'}))});
    expect(order.totals.totalCents).toBe(64690);
    await expect(call('PUT', `/orders/${order.id}/lines`, {version: order.version, lines: [order.lines[0], order.lines[0]]})).rejects.toMatchObject({status: 422});
    await expect(call('PUT', `/orders/${order.id}/lines`, {version: order.version, lines: [{kind: 'LABOR', name: 'Неверно', quantityMilli: 1000, unitPriceCents: 100, variant: 'ORIGINAL'}]})).rejects.toMatchObject({status: 422});
    await expect(call('PUT', `/orders/${order.id}/lines`, {version: order.version, lines: [{kind: 'PART', name: 'Переполнение', quantityMilli: 100000000, unitPriceCents: 1000000000}]})).rejects.toMatchObject({status: 422});
    expect((await call('GET', `/orders/${order.id}`)).version).toBe(order.version);
  });

  it('enforces master assignment, financial redaction and restricted inspection edits', async () => {
    let order = await create();
    const target = order.inspectionItems.find(x => x.catalogItemId === 'cat-0')!;
    order = await call('POST', `/orders/${order.id}/transfer`, {version: order.version, inspectionItemIds: [target.id]});
    db.sqlite.exec("UPDATE Vehicle SET customerId='new-owner' WHERE id='vehicle'");
    await expect(call('GET', `/orders/${order.id}`, undefined, other)).rejects.toMatchObject({status: 404});
    await expect(create(master)).rejects.toMatchObject({status: 403});
    const view = await call('GET', `/orders/${order.id}`, undefined, master);
    expect(view.customerId).toBe('customer');
    expect(view.vehicle.customerId).toBe('');
    expect(view.vehicle.comment).toBe('');
    expect(view.inspectionItems.every(x => x.laborPriceCents === 0)).toBe(true);
    expect(view.lines.every(x => x.unitPriceCents === 0)).toBe(true);
    expect(view.totals.totalCents).toBe(0);
    expect(view.documents).toEqual([]);
    const updated = await call('PUT', `/orders/${order.id}/inspection`, {version: view.version, items: view.inspectionItems.map(x => ({...x, left: true, condition: 'CHECKED'})), recommendations: 'Проверено'}, master);
    expect(updated.inspectionItems.every(x => x.left)).toBe(true);
    expect((await loadOrder(context('GET', '/orders'), order.id)).inspectionItems.find(x => x.id === target.id)?.laborPriceCents).toBe(12345);
    await expect(call('PATCH', `/orders/${order.id}`, {version: updated.version, paidCents: 1}, master)).rejects.toMatchObject({status: 403});
    await expect(call('PUT', `/orders/${order.id}/inspection`, {version: updated.version, items: updated.inspectionItems.map(x => ({...x, quantityMilli: 2000}))}, master)).rejects.toMatchObject({status: 403});
    await expect(call('POST', `/orders/${order.id}/transfer`, {version: updated.version, inspectionItemIds: [target.id]}, master)).rejects.toMatchObject({status: 403});
    const listed = await call<{items: OrderDetail[]}>('GET', '/orders', undefined, master);
    expect(listed.items[0].totals.totalCents).toBe(0);
    expect((await call<{items: OrderDetail[]}>('GET', '/orders', undefined, other)).items).toEqual([]);
  });

  it('allows direct status changes, requires the delivery action and preserves the original date in late edits', async () => {
    let order = await create();
    order = await call('PUT', `/orders/${order.id}/lines`, {version: order.version, lines: [{kind: 'LABOR', name: 'Ремонт', quantityMilli: 1000, unitPriceCents: 50000}]});
    await expect(call('PATCH', `/orders/${order.id}`, {version: order.version, discountCents: 50001})).rejects.toMatchObject({status: 422});
    for (const status of ['APPROVAL', 'READY']) order = await call('PATCH', `/orders/${order.id}`, {version: order.version, status}, master);
    await expect(call('PATCH', `/orders/${order.id}`, {version: order.version, status: 'DELIVERED'}, master)).rejects.toMatchObject({status: 422});
    await expect(call('PATCH', `/orders/${order.id}`, {version: order.version, status: 'DELIVERED'})).rejects.toMatchObject({status: 422});
    await expect(call('PATCH', `/orders/${order.id}`, {version: order.version, paidCents: 50000})).rejects.toMatchObject({status: 422});
    db.sqlite.prepare("UPDATE WorkOrder SET status='DELIVERED',closedAt='2026-01-01T00:00:00.000Z' WHERE id=?").run(order.id);
    order = await call('PATCH', `/orders/${order.id}`, {version:order.version,comment:'Правка'});
    expect(order.closedAt).toBe('2026-01-01T00:00:00.000Z');
    let cancelled = await create();
    cancelled = await call('PATCH', `/orders/${cancelled.id}`, {version: cancelled.version, status: 'CANCELLED'});
    await expect(call('PUT', `/orders/${cancelled.id}/lines`, {version: cancelled.version, lines: []})).rejects.toMatchObject({status: 409});
  });

  it('rolls back stale snapshots and child-write failures without extra audit or version changes', async () => {
    const order = await create();
    const ctx = context('GET', '/orders');
    const snapshot = await loadOrder(ctx, order.id);
    const changed = await call('PATCH', `/orders/${order.id}`, {version: order.version, comment: 'Первый'});
    const auditCount = count('AuditEvent');
    await expect(mutateOrder(ctx, snapshot, snapshot.version, [stmt(db, 'DELETE FROM InspectionItem WHERE orderId=?', [order.id])], 'STALE')).rejects.toMatchObject({status: 409});
    expect(count('InspectionItem')).toBe(110);
    expect(count('AuditEvent')).toBe(auditCount);
    await expect(mutateOrder(ctx, changed, changed.version, [stmt(db, 'UPDATE InspectionItem SET note=? WHERE orderId=?', ['Должно откатиться', order.id]), stmt(db, 'INSERT INTO OrderLine(id,orderId,kind,name,unitPriceCents) VALUES(?,?,?,?,?)', ['bad', order.id, 'INVALID', 'Ошибка', 0])], 'BAD')).rejects.toThrow();
    const fresh = await loadOrder(ctx, order.id);
    expect(fresh.version).toBe(changed.version);
    expect(fresh.inspectionItems.every(x => x.note === '')).toBe(true);
    expect(count('AuditEvent')).toBe(auditCount);
    expect(count('MutationGuard')).toBe(0);
  });

  it('protects new-order mileage and owner snapshots against concurrent changes at the atomic guard', async () => {
    const originalBatch = db.batch.bind(db);
    let intercept = true;
    db.batch = async statements => {
      if (intercept) { intercept = false; db.sqlite.exec("UPDATE Vehicle SET mileage=999,customerId='new-owner' WHERE id='vehicle'"); }
      return originalBatch(statements);
    };
    await expect(create()).rejects.toMatchObject({status: 409});
    expect(count('WorkOrder')).toBe(0);
    expect(count('InspectionItem')).toBe(0);
    expect(count('AuditEvent')).toBe(0);
    expect(db.sqlite.prepare("SELECT mileage FROM Vehicle WHERE id='vehicle'").get()).toMatchObject({mileage: 999});
  });

  it('lists persisted rows with filtering and totals, and does not expose CSV', async () => {
    const order = await create();
    const result = await call<{items: OrderDetail[]; total: number}>('GET', '/orders?q=VINTEST&pageSize=1');
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({id: order.id, totals: {totalCents: 0}});
    expect(await handleOrders(context('GET','/orders/export'))).toBeNull();
    await expect(call('GET', '/orders?status=INVALID')).rejects.toMatchObject({status: 422});
    expect(await handleOrders(context('POST', `/orders/${order.id}/documents`, {}))).toBeNull();
  });
});
