import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createTestDB, SQLiteD1 } from './sqlite-adapter';
import { handleCrud } from '../worker/crud';
import { HttpError } from '../worker/common';
import { all, first, run } from '../worker/db';
import type { Actor } from '../worker/types';
let db: SQLiteD1;
const admin: Actor={id:'admin',name:'Admin',email:'admin@example.com',role:'ADMIN'};
const master: Actor={id:'master',name:'Master',email:'master@example.com',role:'MASTER'};
async function request(path:string, method='GET', data?:unknown, actor=admin): Promise<any> {
 const response=await handleCrud({request:new Request('https://crm.test/api/'+path,{method,...(data?{body:JSON.stringify(data),headers:{'content-type':'application/json'}}:{})}),env:{DB:db},actor,params:{}});
 expect(response).not.toBeNull();return response!.json();
}
async function customer(name='Owner') {return request('customers','POST',{kind:'PERSON',name,phone:'+7 (900) 123-45-67',email:'owner@example.com',comment:'private'});}
async function vehicle(customerId:string) {return request('vehicles','POST',{customerId,make:'Toyota',model:'Camry',mileage:1000,vin:'ABCDE12345',comment:'vehicle private'});}
async function order(customerId:string,vehicleId:string,id='order',masterId:string|null='master') {await run(db,'INSERT INTO WorkOrder (id,number,customerId,vehicleId,masterId,mileage,complaint,discountCents,paidCents) VALUES (?,?,?,?,?,?,?, ?, ?)',[id,id,customerId,vehicleId,masterId,1000,'Noise',100,200]);await run(db,"INSERT INTO OrderLine (id,orderId,kind,name,quantityMilli,unitPriceCents,approval) VALUES (?,?,'LABOR','Work',1000,1000,'APPROVED')",[id+'line',id]);await run(db,"INSERT INTO Payment (id,orderId,kind,amountCents,laborCents,partsCents,unallocatedCents,occurredAt,actorId) VALUES (?,?,'PAYMENT',200,200,0,0,'2026-01-01T12:00:00.000Z','admin')",[id+'payment',id]);}
beforeEach(async()=>{db=createTestDB();for(const actor of [admin,master]) await run(db,'INSERT INTO User (id,name,email,role,providerId) VALUES (?,?,?,?,?)',[actor.id,actor.name,actor.email,actor.role,actor.id+'provider']);await run(db,"INSERT INTO ServiceSettings (id) VALUES ('main')");});
afterEach(()=>db.close());
describe('D1 CRM CRUD',()=>{
 it('normalizes phones and searches with pagination; rejects unknown input',async()=>{await customer();const result=await request('customers?q=7900123&pageSize=1');expect(result.total).toBe(1);expect(result.items[0].phoneNormalized).toBe('79001234567');await expect(request('customers','POST',{kind:'PERSON',name:'x',phone:'12345',extra:true})).rejects.toThrow();});
 it('changes owner atomically and retains history; rejects mileage rollback',async()=>{const a=await customer('A'),b=await customer('B'),v=await vehicle(a.id);await order(a.id,v.id);await request('vehicles/'+v.id,'PATCH',{customerId:b.id,mileage:2000});const history=await all<any>(db,'SELECT * FROM VehicleOwnership WHERE vehicleId=? ORDER BY startedAt',[v.id]);expect(history).toHaveLength(2);expect(history.filter(o=>o.endedAt===null)[0].customerId).toBe(b.id);expect((await first<any>(db,"SELECT * FROM AuditEvent WHERE action='OWNER_CHANGE'"))?.data).toContain(a.id);await expect(request('vehicles/'+v.id,'PATCH',{mileage:1999})).rejects.toMatchObject({status:422});const result=await request('customers/'+a.id);expect(result.orders[0].totals.totalCents).toBe(900);expect(result.orders[0].totals.balanceCents).toBe(700);await request('customers/'+a.id,'PATCH',{archived:true});expect((await request('customers/'+a.id)).orders).toHaveLength(1);});
 it('restricts master scope and redacts a new out-of-scope owner and financial history',async()=>{const a=await customer('A'),b=await customer('B'),v=await vehicle(a.id);await order(a.id,v.id);await request('vehicles/'+v.id,'PATCH',{customerId:b.id});const detail=await request('vehicles/'+v.id,'GET',undefined,master);expect(detail.customer).toBeNull();expect(detail.customerId).toBe('');expect(detail.comment).toBe('');expect(detail.ownerships).toHaveLength(1);expect(detail.ownerships[0].customer.phone).toBe('');expect(detail.orders[0].lines[0].unitPriceCents).toBe(0);expect(detail.orders[0].totals.totalCents).toBe(0);expect((await request('customers','GET',undefined,master)).items.map((x:any)=>x.id)).toEqual([a.id]);await expect(request('customers/'+b.id,'GET',undefined,master)).rejects.toMatchObject({status:404});await expect(request('vehicles/'+v.id,'PATCH',{mileage:2000},master)).rejects.toMatchObject({status:403});});
 it('prevents removal of last active admin and rejects password support',async()=>{await expect(request('staff/admin','PATCH',{active:false})).rejects.toMatchObject({status:409});await expect(request('staff','POST',{name:'x',email:'x@example.com',role:'MASTER',password:'verylongpassword'})).rejects.toThrow();await expect(request('staff/admin','PATCH',{password:'verylongpassword'})).rejects.toThrow();const second=await request('staff','POST',{name:'Second',email:'second@example.com',role:'ADMIN'});expect(second.active).toBe(true);await request('staff/admin','PATCH',{role:'RECEPTION'});expect((await first<any>(db,'SELECT providerId FROM User WHERE id=?',['admin']))?.providerId).toBe('adminprovider');expect((await request('staff','GET',undefined,master)).items.every((x:any)=>x.role==='MASTER'&&x.active)).toBe(true);});
 it('keeps D1 parameter counts under 100 for a full master vehicle page',async()=>{for(let n=0;n<100;n++){const c=await customer('Owner'+n);const v=await request('vehicles','POST',{customerId:c.id,make:'Car',model:'Model',mileage:1000});await order(c.id,v.id,'pageOrder'+n);}const original=db.prepare.bind(db);db.prepare=(sql:string)=>{const statement=original(sql);const bind=statement.bind.bind(statement);statement.bind=(...values:unknown[])=>{expect(values.length).toBeLessThanOrEqual(100);return bind(...values);};return statement;};const page=await request('vehicles?pageSize=100','GET',undefined,master);expect(page.items).toHaveLength(100);expect(page.total).toBe(100);});
 it('loads long histories in a fixed number of SQL queries',async()=>{const c=await customer(),v=await vehicle(c.id);for(let n=0;n<60;n++) await order(c.id,v.id,'order'+n);let queries=0;const original=db.prepare.bind(db);db.prepare=(sql:string)=>{queries++;return original(sql);};const detail=await request('customers/'+c.id);expect(detail.orders).toHaveLength(60);expect(queries).toBeLessThan(15);});
 it('bounds money, preserves inspection snapshots, validates settings and enforces RBAC',async()=>{const item=await request('catalog','POST',{category:'ТО',name:'Inspection',laborPriceCents:100});expect(item.active).toBe(true);const c=await customer(),v=await vehicle(c.id);await order(c.id,v.id);await run(db,"INSERT INTO InspectionItem (id,orderId,catalogItemId,category,name,laborPriceCents,authorId) VALUES ('snapshot','order',?,'ТО','Inspection',100,'admin')",[item.id]);await request('catalog/'+item.id,'PATCH',{laborPriceCents:200,active:false});expect((await request('catalog')).items[0].active).toBe(false);expect((await first<any>(db,"SELECT laborPriceCents FROM InspectionItem WHERE id='snapshot'"))?.laborPriceCents).toBe(100);await expect(request('catalog','POST',{category:'ТО',name:'Other',laborPriceCents:1e9+1})).rejects.toThrow();await expect(request('settings','PATCH',{timezone:'Mars/Base'})).rejects.toThrow();expect((await request('settings','PATCH',{timezone:'UTC'})).timezone).toBe('UTC');await expect(request('settings','GET',undefined,master)).rejects.toBeInstanceOf(HttpError);await expect(request('catalog','POST',{category:'ТО',name:'No'},master)).rejects.toMatchObject({status:403});});
});

it('creates a directory-only master by name and searches client and vehicle visits in local dates',async()=>{
  const {actorFromRequest}=await import('../worker/auth');
  const entry=await request('staff','POST',{name:'Иван'});
  expect(entry).toMatchObject({role:'MASTER',active:true,email:''});
  const stored=await first<{email:string}>(db,'SELECT email FROM User WHERE id=?',[entry.id]);
  await expect(actorFromRequest(new Request('https://crm.test/api/orders',{headers:{'oai-authenticated-user-id':'unknown','oai-authenticated-user-email':stored!.email}}),{DB:db})).rejects.toMatchObject({status:403});
  const c=await customer(),v=await vehicle(c.id); await order(c.id,v.id,'known-visit');
  await run(db,"UPDATE WorkOrder SET openedAt='2026-10-31T22:00:00.000Z' WHERE id='known-visit'");
  for(const resource of ['customers','vehicles']) {
    for(const q of ['Camry','7900123','known-visit']) {
      expect(await request(resource+'?q='+q+'&from=2026-11-01&to=2026-11-01')).toMatchObject({total:1});
    }
    expect(await request(resource+'?to=2026-10-31')).toMatchObject({total:0});
  }
  expect((await request('vehicles/'+v.id+'?to=2026-10-31')).orders).toEqual([]);
});

it('keeps a login-capable administrator when directory records exist, including at the atomic guard',async()=>{
  const directory=await request('staff','POST',{name:'Мастер'});
  for(const role of ['ADMIN','RECEPTION'])
    await expect(request('staff/'+directory.id,'PATCH',{role})).rejects.toMatchObject({status:422});
  // A previously promoted directory entry may already be in the database.
  await run(db,"UPDATE User SET role='ADMIN' WHERE id=?",[directory.id]);
  await expect(request('staff/admin','PATCH',{active:false})).rejects.toMatchObject({status:409});
  const second=await request('staff','POST',{name:'Приглашённый администратор',email:'second@example.test',role:'ADMIN'});
  const batch=db.batch.bind(db);
  db.batch=async statements=>{
    db.sqlite.prepare("UPDATE User SET active=0 WHERE id=?").run(second.id);
    return batch(statements);
  };
  await expect(request('staff/admin','PATCH',{role:'RECEPTION'})).rejects.toMatchObject({status:409});
  expect(await first(db,"SELECT role,active FROM User WHERE id='admin'")).toMatchObject({role:'ADMIN',active:1});
});

it('reads history rows and their discounts as one snapshot across a committed edit',async()=>{
  const {afterRead}=await import('./after-read');
  const c=await customer(), v=await vehicle(c.id); await order(c.id,v.id);
  const changed=afterRead(db,/ledgerPaidCents/,()=>{
    db.sqlite.exec("BEGIN; UPDATE WorkOrder SET discountCents=0; DELETE FROM OrderLine; COMMIT");
  });
  const detail=await request('customers/'+c.id);
  expect(changed()).toBe(true);
  expect(detail.orders[0].totals.totalCents).toBe(900);
  expect(detail.orders[0].lines).toHaveLength(1);
  const fresh=await request('customers/'+c.id);
  expect(fresh.orders[0].totals.totalCents).toBe(0);
  expect(fresh.orders[0].lines).toHaveLength(0);
});

it('matches a visit number only within the selected local dates',async()=>{
  const c=await customer('Фёдор Семёнов'),v=await request('vehicles','POST',{customerId:c.id,make:'ЛаДа',model:'Веста',mileage:0});
  await order(c.id,v.id,'Визит-осень'); await order(c.id,v.id,'Визит-зима');
  db.sqlite.exec("UPDATE WorkOrder SET openedAt=CASE id WHEN 'Визит-осень' THEN '2026-10-20T12:00:00.000Z' ELSE '2026-11-15T12:00:00.000Z' END");
  for(const resource of ['customers','vehicles']){
    expect((await request(resource+'?q=Визит-осень&from=2026-11-01')).total).toBe(0);
    expect((await request(resource+'?q=визит-ОСЕНЬ&to=2026-10-31')).total).toBe(1);
  }
});

it('paginates case-insensitive Cyrillic matches for both customers and vehicles',async()=>{
  for(const name of ['Фёдор Семёнов','ФЁДОР Семёнов','Иванов']){
    const owner=await customer(name);
    const match=name!=='Иванов';
    await request('vehicles','POST',{customerId:owner.id,make:match?'ЛаДа':'ГАЗ',model:match?'Веста':'Волга',mileage:0});
  }
  for(const resource of ['customers','vehicles']){
    for(const q of ['фЁДОР','семёнов','лада','веста']){
      const path=resource+'?q='+encodeURIComponent(q)+'&pageSize=1&page=';
      const first=await request(path+'1'),second=await request(path+'2');
      expect(first.total).toBe(2);
      expect(second.total).toBe(2);
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(1);
      expect(first.items[0].id).not.toBe(second.items[0].id);
    }
  }
});

it('preserves literal GLOB punctuation and Unicode simple case variants in the search',async()=>{
  const match=await customer('Й[Σ]*?');
  await customer('ЙΣ');
  for(const q of ['й[ς]','*','?','[']){
    const result=await request('customers?q='+encodeURIComponent(q));
    expect(result.items.map((row:{id:string})=>row.id)).toEqual([match.id]);
  }
});
