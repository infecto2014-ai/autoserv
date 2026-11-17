import {z} from 'zod';
import {body,fail,json,requireRole} from './common';
import {first,stmt,uuid,now} from './db';
import {loadOrder,mutateOrder,versionField} from './orders';
import {renderDocument} from './pdf';
import type {DocumentSnapshot} from './document-types';
import type {Context} from './types';
import type {Settings,DocumentMeta,DocumentKind} from '../shared/types';
const schema=z.object({kind:z.enum(['INSPECTION','WORK_ORDER']),version:versionField}).strict();
export interface FontBytes {regular:Uint8Array;bold:Uint8Array}
export async function handleDocuments(ctx:Context,fonts:FontBytes):Promise<Response|null>{
 const path=new URL(ctx.request.url).pathname;
 const create=path.match(/^\/api\/orders\/([^/]+)\/documents$/);
 const download=path.match(/^\/api\/documents\/([^/]+)$/);
 if(create&&ctx.request.method==='POST'){
  requireRole(ctx.actor,'ADMIN','RECEPTION');
  const input=schema.parse(await body(ctx.request));
  const id=decodeURIComponent(create[1]);
  const order=await loadOrder(ctx,id);
  if(order.version!==input.version)fail(409,'Заказ изменён. Обновите страницу');
  const settings=await first<Settings>(ctx.env.DB,"SELECT * FROM ServiceSettings WHERE id='main'");if(!settings)fail(422,'Заполните реквизиты сервиса');
  const createdAt=now();const docId=uuid();
  const number=`${input.kind==='INSPECTION'?'АО':'ЗНД'}-${new Date().getUTCFullYear()}-${docId.replaceAll('-','').slice(0,12).toUpperCase()}`;
  const latest=await first<{v:number|null}>(ctx.env.DB,'SELECT MAX(version) AS v FROM Document WHERE orderId=? AND kind=?',[id,input.kind]);
  const version=(latest?.v??0)+1;
  const snapshot:DocumentSnapshot={kind:input.kind,number,createdAt,templateVersion:'cloud-1.0',settings:{name:settings.name,address:settings.address,phone:settings.phone,taxId:settings.taxId,timezone:settings.timezone},order:{number:order.number,openedAt:order.openedAt,mileage:order.mileage,complaint:order.complaint,recommendations:order.recommendations,comment:order.comment,status:order.status},customer:{name:order.customer.name,phone:order.customer.phone},vehicle:{make:order.vehicle.make,model:order.vehicle.model,year:order.vehicle.year,vin:order.vehicle.vin,plate:order.vehicle.plate},masterName:order.master?.name??'Не назначен',inspectionItems:order.inspectionItems.map(({id,category,name,left,right,condition,quantityMilli,laborPriceCents,originalPriceCents,analogPriceCents,customPriceCents,selectedPart,note})=>({id,category,name,left,right,condition,quantityMilli,laborPriceCents,originalPriceCents,analogPriceCents,customPriceCents,selectedPart,note})),lines:order.lines.map(({kind,name,quantityMilli,unitPriceCents,variant,article})=>({kind,name,quantityMilli,unitPriceCents,variant,article})),totals:order.totals};
  const pdf=await renderDocument(snapshot,fonts);
  const snapshotJson=JSON.stringify(snapshot);
  if(pdf.length+new TextEncoder().encode(snapshotJson).length>1900000)fail(422,'Документ слишком велик. Сократите примечания или состав документа');
  const hash=await crypto.subtle.digest('SHA-256',Uint8Array.from(pdf));
  const sha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  await mutateOrder(ctx,order,input.version,[stmt(ctx.env.DB,'INSERT INTO Document (id,orderId,number,kind,version,templateVersion,snapshot,pdf,sha256,authorId,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[docId,id,number,input.kind,version,snapshot.templateVersion,snapshotJson,Uint8Array.from(pdf).buffer,sha256,ctx.actor.id,createdAt])],'DOCUMENT_CREATED',{id:docId,number,sha256},true);
  const metadata:DocumentMeta={id:docId,number,kind:input.kind,version,createdAt,sha256};return json(metadata,201);
 }
 if(download&&ctx.request.method==='GET'){
  requireRole(ctx.actor,'ADMIN','RECEPTION');
  const row=await first<{id:string;number:string;kind:DocumentKind;version:number;pdf:ArrayBuffer|Uint8Array|number[];sha256:string}>(ctx.env.DB,'SELECT id,number,kind,version,pdf,sha256 FROM Document WHERE id=?',[decodeURIComponent(download[1])]);if(!row)fail(404,'Документ не найден');
  const bytes=row.pdf instanceof ArrayBuffer?new Uint8Array(row.pdf):Uint8Array.from(row.pdf);
  const disposition=new URL(ctx.request.url).searchParams.get('download')==='1'?'attachment':'inline';
  return new Response(bytes,{headers:{'content-type':'application/pdf','content-disposition':`${disposition}; filename="document-${row.version}.pdf"; filename*=UTF-8''${encodeURIComponent(row.number)}.pdf`,'cache-control':'private, no-store',etag:`"${row.sha256}"`}});
 }
 return null;
}
