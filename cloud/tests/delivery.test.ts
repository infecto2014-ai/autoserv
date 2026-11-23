import {afterEach, beforeEach, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {handleApi} from '../worker/api';
import {renderDocument} from '../worker/pdf';
import type {DocumentSnapshot} from '../worker/document-types';
import {SQLiteD1} from './sqlite-adapter';
import type {DocumentMeta, OrderDetail} from '../shared/types';

const fonts = {regular:readFileSync('assets/DejaVuSans.ttf'),bold:readFileSync('assets/DejaVuSans-Bold.ttf')};
let db: SQLiteD1;
beforeEach(() => { db = new SQLiteD1(); });
afterEach(() => db.close());

function request(path: string, method = 'GET', data?: unknown, renderFonts = fonts) {
  const request = new Request('https://crm.test/api/' + path, {method, body: JSON.stringify(data),
    headers: {origin:'https://crm.test','content-type':'application/json','oai-authenticated-user-id':'owner',
      'oai-authenticated-user-email':'owner@example.test','oai-authenticated-user-full-name':encodeURIComponent('Анна Приёмщик'),
      'oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8'}});
  return handleApi(request, {DB:db}, renderFonts);
}
async function api<T = OrderDetail>(path: string, method = 'GET', data?: unknown, status = 200) {
  const response = await request(path, method, data);
  const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(status); return value as T;
}
const intake = () => api('intake', 'POST', {requestId:'visit',make:'Лада',complaint:'Шум',phone:'123456'},201);
const line = {kind:'LABOR',name:'Диагностика',quantityMilli:1000,unitPriceCents:0,approval:'APPROVED',completed:true};
type Delivery = {order:OrderDetail; document:DocumentMeta};
async function pdf(meta: DocumentMeta) {
  const response = await request('documents/' + meta.id);
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(meta.sha256);
  return execFileSync('pdftotext',['-layout','-','-'],{input:bytes,encoding:'utf8'}).replace(/\s+/gu,' ');
}
function saved(id: string) {
  return (db.sqlite.prepare('SELECT snapshot FROM Document WHERE id=?').get(id) as {snapshot:string}).snapshot;
}

it('выдаёт автомобиль с долгом один раз, сохраняет подписи и обновляет акт независимо от даты выдачи', async () => {
  let order = await intake(); const path = 'orders/' + order.id;
  order = await api(path+'/lines','PUT',{version:order.version,lines:[
    {...line,unitPriceCents:120000},{...line,kind:'PART',name:'Фильтр сервиса',unitPriceCents:40000},
    {...line,kind:'PART',partSource:'CUSTOMER',name:'Датчик клиента',unitPriceCents:98765},
    {...line,name:'Отложенный насос',approval:'DEFERRED',completed:false}]});
  order = await api(path,'PATCH',{version:order.version,status:'READY',discountCents:20000,recommendations:'Осмотреть привод'});
  const input = {requestId:'delivery',version:order.version,includeRecommendations:true};
  const [a,b] = await Promise.all([api<Delivery>(path+'/deliver','POST',input),api<Delivery>(path+'/deliver','POST',input)]);
  expect(a.document).toEqual(b.document);
  expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM AuditEvent WHERE entityId=? AND action='ORDER_DELIVERED'").get(order.id)).toMatchObject({n:1});
  expect(a.order).toMatchObject({status:'DELIVERED',closedAt:a.document.createdAt,documents:[a.document],
    completionActNeedsUpdate:false,totals:{totalCents:140000,balanceCents:140000}});
  await api(path+'/deliver','POST',{...input,includeRecommendations:false},409);
  await api(path+'/deliver','POST',{...input,requestId:'another',version:a.order.version},409);
  const original = saved(a.document.id);
  const doc = JSON.parse(original);
  expect(doc.lines).toHaveLength(3);
  expect(doc).toMatchObject({signerName:'Анна Приёмщик',includeRecommendations:true,totals:{partsCents:40000,discountCents:20000}});
  const text = await pdf(a.document);
  for (const value of ['АКТ ВЫПОЛНЕННЫХ РАБОТ','TOP-СЕРВИС','Стрелецкая','+79114709360','Клиент: ______',
    'Сотрудник: ______','Анна Приёмщик','Фильтр сервиса','Датчик клиента','Деталь клиента','Отложенный насос','Осмотреть привод','1 400,00']) expect(text).toContain(value);
  expect(text).not.toContain('987,65');
  for (const value of ['Без запчасти','Артикул: —','Шаблон','Europe/Kaliningrad','ИНН:','Пробег: 0 км']) expect(text).not.toContain(value);
  expect(text).toContain('Страница 1 из 1');
  order = await api(path+'/payments','POST',{version:a.order.version,requestId:'pay',amountCents:140000});
  expect(order).toMatchObject({completionActNeedsUpdate:false,closedAt:a.order.closedAt});
  order = await api(path,'PATCH',{version:order.version,discountCents:30000});
  expect(order).toMatchObject({completionActNeedsUpdate:true,closedAt:a.order.closedAt});
  const next = await api<DocumentMeta>(path+'/documents','POST',{version:order.version,kind:'WORK_ORDER',includeRecommendations:false},201);
  expect(next.version).toBe(a.document.version+1);
  const updated = await pdf(next);
  for(const value of ['Осмотреть привод','Рекомендации','Отложенный насос']) expect(updated).not.toContain(value);
  expect(JSON.parse(saved(next.id))).toMatchObject({includeRecommendations:false,totals:{totalCents:130000,paidCents:140000}});
  expect(saved(a.document.id)).toBe(original);
  expect(await pdf(a.document)).toBe(text);
  const replay = await api<Delivery>(path+'/deliver','POST',input);
  expect(replay.document).toEqual(a.document);
  expect(replay.order).toMatchObject({completionActNeedsUpdate:false,closedAt:a.order.closedAt});
  expect(replay.order.documents).toHaveLength(2);
});

it('отклоняет неразобранные позиции и откатывает выдачу при ошибке шрифта; выдаёт после бесплатной диагностики', async () => {
  let order = await intake(); const path = 'orders/' + order.id;
  order = await api(path,'PATCH',{version:order.version,status:'READY'});
  for (const approval of ['PENDING','APPROVED']) {
    order = await api(path+'/lines','PUT',{version:order.version,lines:[{...line,id:order.lines[0]?.id,completed:false,approval}]});
    await api(path+'/deliver','POST',{version:order.version,requestId:'delivery',includeRecommendations:false},422);
  }
  order = await api(path+'/lines','PUT',{version:order.version,lines:[{...order.lines[0],approval:'DEFERRED'},line]});
  const input = {version:order.version,requestId:'delivery',includeRecommendations:false};
  const response = await request(path+'/deliver','POST',input,{regular:Buffer.alloc(0),bold:Buffer.alloc(0)});
  expect(response.status).toBe(500);
  expect(await api(path)).toMatchObject({status:'READY',version:order.version,closedAt:null,documents:[]});
  expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM WorkflowRequest WHERE requestId='delivery'").get()).toMatchObject({n:0});
  // Deliberately fail the request-key write after inserting the PDF and setting closedAt.
  db.sqlite.exec(`CREATE TRIGGER interrupt_delivery BEFORE INSERT ON WorkflowRequest WHEN NEW.operation='DELIVERY'
    BEGIN SELECT RAISE(ABORT,'simulated transaction failure'); END;`);
  await api(path+'/deliver','POST',input,500);
  expect(await api(path)).toMatchObject({status:'READY',version:order.version,closedAt:null,documents:[]});
  db.sqlite.exec('DROP TRIGGER interrupt_delivery');
  expect(await api<Delivery>(path+'/deliver','POST',input)).toMatchObject({order:{status:'DELIVERED',totals:{totalCents:0}}});
});


it('открывает прежний заказ-наряд до сверки и продолжает нумерацию после проверки', async () => {
  db.close();
  db = new SQLiteD1(':memory:',false);
  db.migrate('0000_initial');
  db.sqlite.exec(`INSERT INTO User(id,providerId,email,name,role) VALUES ('old-user','owner','owner@example.test','Приёмщик','ADMIN');
    INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES ('c','Клиент','123456','123456');
    INSERT INTO Vehicle(id,customerId,make,model) VALUES ('v','c','Лада','');
    INSERT INTO WorkOrder(id,number,customerId,vehicleId,mileage,complaint,status) VALUES ('o','ЗН-1','c','v',0,'Осмотр','READY');
    INSERT INTO OrderLine(id,orderId,kind,name,unitPriceCents) VALUES ('work','o','LABOR','Диагностика',10000);`);
  const old: DocumentSnapshot = {kind:'WORK_ORDER',templateVersion:'cloud-1.0',number:'ЗНД-1',createdAt:'2025-01-01T10:00:00Z',
    settings:{name:'Прежний сервис',address:'',phone:'',taxId:'',timezone:'Europe/Kaliningrad'},
    order:{number:'ЗН-1',openedAt:'2025-01-01T08:00:00Z',mileage:0,complaint:'Осмотр',recommendations:'',comment:'',status:'READY'},
    customer:{name:'Клиент',phone:'123456'},vehicle:{make:'Лада',model:'',plate:null,vin:null,year:null},masterName:'Не назначен',inspectionItems:[],
    lines:[{name:'Диагностика',kind:'LABOR',quantityMilli:1000,unitPriceCents:10000,article:'',variant:'NONE'}],
    totals:{laborCents:10000,partsCents:0,discountCents:0,subtotalCents:10000,totalCents:10000,paidCents:0,balanceCents:10000}};
  const bytes = await renderDocument(old,fonts);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  db.sqlite.prepare(`INSERT INTO Document(id,orderId,number,kind,version,templateVersion,snapshot,pdf,sha256,authorId)
    VALUES ('old','o','ЗНД-1','WORK_ORDER',1,'cloud-1.0',?,?,?,'old-user')`).run(JSON.stringify(old),bytes,sha256);
  db.migrate();
  const order = await api('orders/o');
  const oldMeta = order.documents[0];
  expect(await pdf(oldMeta)).toContain('ЗАКАЗ-НАРЯД');
  await api('orders/o/deliver','POST',{requestId:'deliver',version:order.version,includeRecommendations:false},409);
  await api('orders/o/documents','POST',{kind:'WORK_ORDER',version:order.version},409);
  const reviewed = await api('orders/o/review-finances','POST',{version:order.version,decisions:[{id:'work',approval:'APPROVED',completed:true}]});
  const result = await api<Delivery>('orders/o/deliver','POST',{requestId:'deliver',version:reviewed.version,includeRecommendations:false});
  expect(result.document).toMatchObject({version:2,templateVersion:'completion-act-1.0'});
  expect(result.order.documents).toHaveLength(2);
  expect(await pdf(oldMeta)).toContain('Прежний сервис');
  expect(saved(oldMeta.id)).toBe(JSON.stringify(old));
});
