import {z} from 'zod';
import {body,fail, versionConflict,json,requireRole} from './common';
import {first,stmt,uuid,now} from './db';
import {loadOrder,mutateOrder,versionField} from './orders';
import {assertReviewed, totalsForOrder} from './finances';
import {requestIdField, withRequest} from './workflow-request';
import {completionContent, completionContentHash, completionTemplate, customerAndVehicle, serviceDetails, unresolvedLine} from './completion-act';
import {canTransition} from '../shared/status';
import {renderDocument} from './pdf';
import type {DocumentSnapshot} from './document-types';
import type {Context,D1PreparedStatement} from './types';
import type {Settings,DocumentMeta,DocumentKind,OrderDetail} from '../shared/types';

const createSchema = z.object({kind:z.enum(['INSPECTION','WORK_ORDER']),version:versionField,includeRecommendations:z.boolean().default(false)}).strict();
const deliverySchema = z.object({requestId:requestIdField,version:versionField,includeRecommendations:z.boolean()}).strict();
export interface FontBytes {regular:Uint8Array;bold:Uint8Array}

async function saveDocument(ctx: Context, fonts: FontBytes, id: string, input: z.infer<typeof createSchema>,
  recordDelivery?: (orderId: string, documentId: string) => D1PreparedStatement): Promise<DocumentMeta> {
  const order = await loadOrder(ctx,id);
  if(order.version !== input.version) versionConflict();
  if(input.kind === 'WORK_ORDER') {
    assertReviewed(order);
    if(order.status === 'CANCELLED') fail(409,'Заказ отменён');
    if(recordDelivery && order.status === 'DELIVERED') fail(409,'Автомобиль уже выдан. Можно создать новую версию акта');
    if(recordDelivery && !canTransition(order.status,'DELIVERED',ctx.actor.role)) fail(422,'Переведите заказ в статус «Готов» перед выдачей');
    const unresolved = unresolvedLine(order);
    if(unresolved) fail(422,`Позиция «${unresolved.name}»: подтвердите согласование и выполнение либо отложите позицию`);
  }
  const db = ctx.env.DB;
  const settings = await first<Settings>(db,"SELECT * FROM ServiceSettings WHERE id='main'");
  if(!settings) fail(422,'Заполните реквизиты сервиса');
  const createdAt = now(), docId = uuid();
  const prefix = input.kind === 'INSPECTION' ? 'АО' : 'АВР';
  const number = `${prefix}-${createdAt.slice(0,4)}-${docId.replaceAll('-','').slice(0,12).toUpperCase()}`;
  const version = order.documents.reduce((latest,doc) => doc.kind === input.kind ? Math.max(latest,doc.version) : latest,0)+1;
  const header = {kind:input.kind, number, createdAt, version};
  let snapshot: DocumentSnapshot;
  if(input.kind === 'WORK_ORDER') {
    const content = completionContent(recordDelivery ? {...order,status:'DELIVERED'} : order, settings, input.includeRecommendations);
    snapshot = {...header, ...content, templateVersion:completionTemplate, signerName:ctx.actor.name, inspectionItems:[],
      printedContentHash:await completionContentHash(content, order.discountCents), totals:totalsForOrder({...order,status:'DELIVERED'})};
  } else {
    const {number,openedAt,mileage,complaint,recommendations,comment,status} = order;
    snapshot = {...header, ...customerAndVehicle(order), masterName:order.master?.name ?? 'Не назначен', templateVersion:'cloud-1.0',
      settings:serviceDetails(settings), order:{number,openedAt,mileage,complaint,recommendations,comment,status},
      inspectionItems:order.inspectionItems.map(({id,category,name,left,right,condition,quantityMilli,laborPriceCents,originalPriceCents,analogPriceCents,customPriceCents,selectedPart,note}) =>
        ({id,category,name,left,right,condition,quantityMilli,laborPriceCents,originalPriceCents,analogPriceCents,customPriceCents,selectedPart,note})),
      lines:order.lines.map(({kind,name,quantityMilli,unitPriceCents,variant,article}) => ({kind,name,quantityMilli,unitPriceCents,variant,article})),
      totals:order.totals};
  }
  const pdf = await renderDocument(snapshot,fonts);
  const snapshotJson = JSON.stringify(snapshot);
  if(pdf.length+new TextEncoder().encode(snapshotJson).length>1900000) fail(422,'Документ слишком велик. Сократите примечания или состав документа');
  const bytes = Uint8Array.from(pdf);
  const hash = await crypto.subtle.digest('SHA-256',bytes);
  const sha256 = Array.from(new Uint8Array(hash),b => b.toString(16).padStart(2,'0')).join('');
  const document = {id:docId,number,kind:input.kind,version,createdAt,sha256,templateVersion:snapshot.templateVersion};
  const writes = [stmt(db,`INSERT INTO Document (id,orderId,number,kind,version,templateVersion,snapshot,pdf,sha256,authorId,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[docId,id,number,input.kind,version,snapshot.templateVersion,snapshotJson,bytes.buffer,sha256,ctx.actor.id,createdAt])];
  if(recordDelivery) writes.push(stmt(db,"UPDATE WorkOrder SET status='DELIVERED',closedAt=? WHERE id=?",[createdAt,id]),recordDelivery(id,docId));
  await mutateOrder(ctx,order,input.version,writes,recordDelivery ? 'ORDER_DELIVERED' : 'DOCUMENT_CREATED',document,input.kind === 'INSPECTION');
  return document;
}

export async function handleDocuments(ctx:Context,fonts:FontBytes):Promise<Response|null>{
 const path=new URL(ctx.request.url).pathname;
 const create=path.match(/^\/api\/orders\/([^/]+)\/documents$/);
 const delivery=path.match(/^\/api\/orders\/([^/]+)\/deliver$/);
 const download=path.match(/^\/api\/documents\/([^/]+)$/);
 if(delivery && ctx.request.method === 'POST') {
   requireRole(ctx.actor,'ADMIN','RECEPTION');
   const id = decodeURIComponent(delivery[1]);
   const input = deliverySchema.parse(await body(ctx.request));
   return withRequest(ctx,'DELIVERY',input.requestId,{orderId:id,...input},async record => {
     await saveDocument(ctx,fonts,id,{kind:'WORK_ORDER',version:input.version,includeRecommendations:input.includeRecommendations},record);
     return id;
   },200,(order: OrderDetail, resultId) => {
     const document = order.documents.find(doc => doc.id === resultId);
     if(!document) fail(500,'Не найден сохранённый акт выдачи');
     return {order,document};
   });
 }
 if(create && ctx.request.method === 'POST') {
   requireRole(ctx.actor,'ADMIN','RECEPTION');
   const input = createSchema.parse(await body(ctx.request));
   return json(await saveDocument(ctx,fonts,decodeURIComponent(create[1]),input),201);
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
