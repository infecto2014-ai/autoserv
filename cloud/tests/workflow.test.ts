import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {handleApi} from '../worker/api';
import {SQLiteD1} from './sqlite-adapter';
import type {OrderDetail} from '../shared/types';
const fonts={regular:new Uint8Array(readFileSync('assets/DejaVuSans.ttf')),bold:new Uint8Array(readFileSync('assets/DejaVuSans-Bold.ttf'))};
function req(path:string,method='GET',payload?:unknown,id='owner'){
 return new Request('https://crm.test'+path,{method,headers:{'oai-authenticated-user-id':id,'oai-authenticated-user-email':`${id}@example.test`,origin:'https://crm.test','content-type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)});
}
describe('cloud complete API workflow',()=>{
 it('accepts a visit and preserves immutable PDF versions through delivery, settlement and corrections',async()=>{
  const db=new SQLiteD1();
  try{
   async function api<T>(path:string,method='GET',payload?:unknown,status=200):Promise<T>{const r=await handleApi(req(path,method,payload),{DB:db},fonts);const x=await r.json();expect(r.status,JSON.stringify(x)).toBe(status);return x as T;}
   const session=await api<{user:{role:string}}>('/api/auth/session');expect(session.user.role).toBe('ADMIN');
   const intake = {requestId:'intake-e2e',make:'Лада',model:'Веста',phone:'+79990001122',name:'Тестовый клиент',mileage:1100,complaint:'Проверка тормозов'};
   let order=await api<OrderDetail>('/api/intake','POST',intake,201);
   const repeated=await api<OrderDetail>('/api/intake','POST',intake);
   expect(repeated.id).toBe(order.id);
   const path=`/api/orders/${order.id}`;
   order=await api<OrderDetail>(path+'/payments','POST',{requestId:'prepayment-e2e',version:order.version,amountCents:10000});
   expect(order.payments?.[0].unallocatedCents).toBe(10000);
   expect(order.inspectionItems).toHaveLength(110);
   const item=order.inspectionItems[0];
   order=await api<OrderDetail>(`/api/orders/${order.id}/inspection`,'PUT',{version:order.version,recommendations:'Повторить проверку через месяц',items:order.inspectionItems.map(x=>x.id===item.id?{...x,left:true,right:true,condition:'REPAIR',quantityMilli:1500,laborPriceCents:12001,originalPriceCents:30003,analogPriceCents:20002,selectedPart:'ANALOG'}:x)});
   order=await api<OrderDetail>(`/api/orders/${order.id}/transfer`,'POST',{version:order.version,inspectionItemIds:[item.id]});expect(order.totals.totalCents).toBe(0);
   order=await api<OrderDetail>(path+'/lines','PUT',{version:order.version,lines:order.lines.map(l=>({...l,approval:l.kind==='LABOR'?'APPROVED':'DEFERRED',completed:l.kind==='LABOR'}))});
   expect(order.totals).toMatchObject({laborCents:18002,partsCents:0,totalCents:18002,paidCents:10000,balanceCents:8002});
   expect(order.payments?.[0].laborCents).toBe(10000);
   order=await api<OrderDetail>(path,'PATCH',{version:order.version,status:'READY',discountCents:1000});
   const docs: {id:string;sha256:string;number:string}[]=[];
   docs.push(await api(path+'/documents','POST',{version:order.version,kind:'INSPECTION'},201));
   order=await api(path);
   const delivered=await api<{order:OrderDetail;document:typeof docs[number]}>(path+'/deliver','POST',{requestId:'delivery-e2e',version:order.version,includeRecommendations:true});
   order=delivered.order;
   docs.push(delivered.document);
   expect(order).toMatchObject({status:'DELIVERED',totals:{discountCents:1000,balanceCents:7002}});
   const closedAt=order.closedAt;
   order=await api<OrderDetail>(path+'/payments','POST',{requestId:'settlement-e2e',version:order.version,amountCents:7002});
   expect(order).toMatchObject({closedAt,completionActNeedsUpdate:false,totals:{balanceCents:0}});
   order=await api<OrderDetail>(path,'PATCH',{version:order.version,comment:'Уточнение после выдачи'});
   expect(order).toMatchObject({closedAt,completionActNeedsUpdate:true});
   docs.push(await api(path+'/documents','POST',{version:order.version,kind:'WORK_ORDER'},201));
   order=await api(path);
   expect(order.documents).toHaveLength(3);
   await api('/api/settings','PATCH',{name:'Изменённый сервис'});
   for(const doc of docs){
    const r=await handleApi(req(`/api/documents/${doc.id}`),{DB:db},fonts);expect(r.status).toBe(200);
    const bytes=new Uint8Array(await r.arrayBuffer());expect(new TextDecoder().decode(bytes.slice(0,4))).toBe('%PDF');
    const hash=await crypto.subtle.digest('SHA-256',bytes);expect(Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('')).toBe(doc.sha256);
    const saved=db.sqlite.prepare('SELECT snapshot FROM Document WHERE id=?').get(doc.id) as {snapshot:string};expect(JSON.parse(saved.snapshot).settings.name).toBe('TOP-СЕРВИС');
   }
   const history=await api<{orders:{id:string}[]}>(`/api/vehicles/${order.vehicleId}`);expect(history.orders[0].id).toBe(order.id);
   expect((await handleApi(new Request('https://crm.test/api/orders'),{DB:db},fonts)).status).toBe(401);
   expect((await handleApi(req('/api/orders','GET',undefined,'foreign'),{DB:db},fonts)).status).toBe(403);
   const cross=req('/api/customers','POST',{kind:'PERSON',name:'x',phone:'123456'});cross.headers.set('origin','https://other.test');expect((await handleApi(cross,{DB:db},fonts)).status).toBe(403);
  }finally{db.close();}
 });
});
