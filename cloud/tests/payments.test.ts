import {afterEach, beforeEach, expect, it} from 'vitest';
import {handleApi} from '../worker/api';
import {SQLiteD1} from './sqlite-adapter';
import type {OrderDetail} from '../shared/types';

let db: SQLiteD1;
beforeEach(() => {db = new SQLiteD1();});
afterEach(() => db.close());
async function api<T = OrderDetail>(path: string, method = 'GET', data?: unknown, status = 200) {
  const request = new Request('https://crm.test/api/' + path, {method, body: data ? JSON.stringify(data) : undefined,
    headers: {origin:'https://crm.test', 'content-type':'application/json','oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'}});
  const response = await handleApi(request, {DB:db}, {regular:new Uint8Array(),bold:new Uint8Array()});
  const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(status); return result as T;
}
const intake = () => api('intake', 'POST', {requestId:'visit', make:'Lada', complaint:'Ремонт', phone:'123456'}, 201);
const line = (kind: string, unitPriceCents: number) => ({kind, name:kind, quantityMilli:1000, unitPriceCents,completed:true});
it('allocates an advance once, requires fresh consent, retains delivery date and refunds the removed component', async () => {
  let order = await intake(); const path = 'orders/' + order.id;
  const payment = {requestId:'money', version:order.version, amountCents:900000};
  const [a,b] = await Promise.all([api(path+'/payments','POST',payment),api(path+'/payments','POST',payment)]);
  expect(a.payments).toHaveLength(1); expect(b.id).toBe(a.id);
  order = a;
  expect(order.payments![0].unallocatedCents).toBe(900000);
  await api(path+'/payments','POST',{...payment,amountCents:1},409);
  await api(path+'/payments','POST',{...payment,requestId:'stale'},409);
  order = await api(path+'/lines','PUT',{version:order.version, lines:[line('LABOR',300000),line('PART',600000)]});
  expect(order.totals.totalCents).toBe(0);
  order = await api(path+'/lines','PUT',{version:order.version, lines:order.lines.map(l=>({...l,approval:'APPROVED'}))});
  expect(order.payments![0]).toMatchObject({laborCents:300000,partsCents:600000,unallocatedCents:0});
  const sourceId = order.payments![0].id;
  const closedAt = '2026-10-30T22:00:00.000Z';
  db.sqlite.prepare("UPDATE WorkOrder SET status='DELIVERED',closedAt=?,openedAt='2026-09-01T00:00:00.000Z' WHERE id=?").run(closedAt,order.id);
  db.sqlite.prepare("UPDATE Payment SET occurredAt='2026-10-31T21:59:59.999Z' WHERE id=?").run(sourceId);
  order = await api(path+'/lines','PUT',{version:order.version, lines:order.lines.map(l=>l.kind==='PART'?{...l,unitPriceCents:1}:l)});
  expect(order.lines.find(l=>l.kind==='PART')?.approval).toBe('PENDING');
  expect(order.totals).toMatchObject({totalCents:300000,overpaidCents:600000,balanceCents:0});
  order = await api(path+'/payments','POST',{version:order.version,requestId:'refund',kind:'REFUND',relatedPaymentId:sourceId,reason:'Деталь исключена',amountCents:600000});
  const refund = order.payments!.find(p=>p.kind==='REFUND')!;
  expect(refund).toMatchObject({partsCents:600000,laborCents:0});
  db.sqlite.prepare("UPDATE Payment SET occurredAt='2026-10-31T22:00:00.000Z' WHERE id=?").run(refund.id);
  expect(order.closedAt).toBe(closedAt); expect(order.totals.overpaidCents).toBe(0);
  await api(path+'/payments','POST',{version:order.version,requestId:'tooMuch',kind:'REFUND',relatedPaymentId:sourceId,reason:'Ошибка',amountCents:300001},422);
  expect(await api('overview?from=2026-10-01&to=2026-10-31')).toMatchObject({counts:{completed:1},money:{laborCents:300000,partsCents:600000,totalCents:900000,debtCents:0}});
  expect(await api('overview?from=2026-11-01&to=2026-11-01')).toMatchObject({counts:{completed:0},money:{partsCents:-600000,totalCents:-600000}});
});

it('continues a legacy balance and reviews actual lines without inventing a historical payment date', async () => {
  db.close(); db = new SQLiteD1(':memory:',false); db.migrate('0000_initial');
  db.sqlite.exec(`INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES ('c','Клиент','12345','12345');
    INSERT INTO Vehicle(id,customerId,make,model) VALUES ('v','c','Лада','');
    INSERT INTO WorkOrder(id,number,customerId,vehicleId,mileage,complaint,paidCents,status,closedAt,openedAt)
      VALUES('o','1','c','v',0,'Осмотр',400000,'DELIVERED','2024-01-01T12:00:00.000Z','2023-12-01T00:00:00.000Z');
    INSERT INTO OrderLine(id,orderId,kind,name,unitPriceCents) VALUES('l','o','LABOR','Ремонт',1000000);`);
  db.migrate();
  const old = await api('orders/o');
  expect(old.totals.balanceCents).toBe(600000);
  expect(await api('overview?from=2020-01-01&to=2020-12-31')).toMatchObject({counts:{completed:0},money:{debtCents:600000,totalCents:0}});
  expect(await api('orders?debtOnly=1')).toMatchObject({total:1,items:[{id:'o',totals:{balanceCents:600000}}]});
  await api('orders/o/lines','PUT',{version:old.version,lines:[]},409);
  await api('orders/o','PATCH',{version:old.version,discountCents:1},409);
  let order = await api('orders/o/payments','POST',{version:old.version,requestId:'late',amountCents:100000});
  db.sqlite.exec("UPDATE Payment SET occurredAt='2026-11-01T00:00:00.000Z' WHERE kind='PAYMENT'");
  expect(order.totals.balanceCents).toBe(500000); expect(order.financialMode).toBe('LEGACY');
  order = await api('orders/o/review-finances','POST',{version:order.version,decisions:[{id:'l',approval:'APPROVED',completed:true}]});
  expect(order.financialMode).toBe('WORKFLOW'); expect(order.totals.balanceCents).toBe(500000);
  expect(order.legacySnapshot?.balanceCents).toBe(600000); expect(order.closedAt).toBe(old.closedAt);
  expect(order.payments!.find(p=>p.kind==='OPENING')).toMatchObject({unallocatedCents:400000,occurredAt:null});
  expect(order.payments!.find(p=>p.kind==='PAYMENT')).toMatchObject({laborCents:100000});
  expect(await api('overview')).toMatchObject({money:{totalCents:500000,laborCents:100000,unallocatedCents:400000}});
  expect(await api('overview?from=2026-01-01&to=2026-12-31')).toMatchObject({counts:{completed:0},money:{totalCents:100000,laborCents:100000,unallocatedCents:0,debtCents:500000}});
});

it('applies the labor discount and filters service parts and consent before distributing each new payment', async () => {
  let order = await intake(); const path = 'orders/' + order.id;
  order = await api(path+'/lines','PUT',{version:order.version,lines:[
    {...line('LABOR',400000),approval:'APPROVED'}, {...line('PART',600000),approval:'APPROVED'},
    {...line('PART',350000),approval:'APPROVED',partSource:'CUSTOMER'}, {...line('LABOR',200000),approval:'DEFERRED'}]});
  order = await api(path,'PATCH',{version:order.version,discountCents:100000});
  await api(path,'PATCH',{version:order.version,discountCents:400001},422);
  order = await api(path+'/payments','POST',{version:order.version,requestId:'first',amountCents:300000});
  expect(order.payments![0]).toMatchObject({laborCents:100000,partsCents:200000});
  expect(order.totals).toMatchObject({totalCents:900000,paidCents:300000,balanceCents:600000});
  for (const requestId of ['large1','large2']) order = await api(path+'/payments','POST',{version:order.version,requestId,amountCents:600000000});
  expect(order.paidCents).toBe(1200300000);
  expect(await api('overview')).toMatchObject({money:{totalCents:1200300000,debtCents:0}});
});
