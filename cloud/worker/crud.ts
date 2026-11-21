import { z } from 'zod';
import { calculateTotals } from '../shared/money';
import type { LegacyFinancialSnapshot, OrderDetail } from '../shared/types';
import { dateFilter, financeCTE } from './overview';
import { totalsForOrder } from './finances';
import type { Context, D1Database, D1PreparedStatement, Actor } from './types';
import { body, fail, json, requireRole, pagination } from './common';
import { all, first, stmt, batch, guarded, uuid, now } from './db';

type Row = Record<string, any>;
const text = (n: number) => z.string().trim().max(n);
const required = (n: number) => text(n).min(1);
const id = required(100);
const money = z.number().int().min(0).max(1_000_000_000);
const phone = required(50).refine(v => v.replace(/\D/g, '').length >= 5, 'Укажите корректный телефон');
const email = z.union([z.email().max(254), z.literal(''), z.null()]).transform(v => v || null);
export const customerCreate = z.strictObject({ kind: z.enum(['PERSON','COMPANY']), name: required(200), phone, email: email.optional(), comment: text(10000).optional() });
export const customerPatch = customerCreate.omit({ kind: true }).partial().extend({ archived: z.boolean().optional() }).refine(v => Object.keys(v).length > 0, 'Нет изменений');
export const vehicleCreate = z.strictObject({ customerId: id, make: required(100), model: required(100), year: z.number().int().min(1886).max(new Date().getUTCFullYear()+1).nullable().optional(), vin: z.union([text(17).regex(/^[A-HJ-NPR-Z0-9]{5,17}$/i),z.literal(''),z.null()]).transform(v => v?.toUpperCase() || null).optional(), plate: text(30).nullable().optional(), mileage: z.number().int().min(0).max(10000000), engine: text(300).optional(), comment: text(10000).optional() });
export const vehiclePatch = vehicleCreate.partial().extend({ archived: z.boolean().optional() }).refine(v => Object.keys(v).length > 0, 'Нет изменений');
const role = z.enum(['ADMIN','RECEPTION','MASTER']);
export const staffCreate = z.union([
  z.strictObject({name:required(200),role:z.literal('MASTER').default('MASTER')}),
  z.strictObject({name:required(200),email:z.email().max(254).transform(v=>v.toLowerCase()),role:z.enum(['ADMIN','RECEPTION'])}),
]);
export const staffPatch = z.strictObject({ name: required(200).optional(), role: role.optional(), active: z.boolean().optional() }).refine(v => Object.keys(v).length > 0, 'Нет изменений');
export const catalogCreate = z.strictObject({ category: required(100), name: required(200), unit: required(30).optional(), laborPriceCents: money.optional(), sortOrder: z.number().int().min(0).max(1000000).optional() });
export const catalogPatch = catalogCreate.partial().extend({ active: z.boolean().optional() }).refine(v => Object.keys(v).length > 0, 'Нет изменений');
export function validTimezone(value: string) { try { new Intl.DateTimeFormat('en', { timeZone: value }); return value === 'UTC' || value.includes('/'); } catch { return false; } }
export const settingsPatch = z.strictObject({ name: required(200).optional(), address: text(1000).optional(), phone: text(50).optional(), taxId: text(30).optional(), timezone: required(100).refine(validTimezone, 'Укажите IANA часовой пояс').optional() }).refine(v => Object.keys(v).length > 0, 'Нет изменений');
const staffColumns = "id,name,CASE WHEN email LIKE 'directory:%' THEN '' ELSE email END AS email,role,active";
const bools = (r: Row) => ({ ...r, active: !!r.active });
function scope(actor: Actor, entity: 'Customer'|'Vehicle', alias: string): {sql:string,args:unknown[]} {
  return actor.role === 'MASTER' ? { sql: `EXISTS (SELECT 1 FROM WorkOrder scopeOrder WHERE scopeOrder.${entity === 'Customer' ? 'customerId' : 'vehicleId'} = ${alias}.id AND scopeOrder.masterId = ?)`, args: [actor.id] } : {sql:'1',args:[]};
}
function customerDTO(row: Row, actor: Actor): Row { return actor.role === 'MASTER' ? { ...row, phone:'',phoneNormalized:'',email:null,comment:'' } : row; }
function audit(db: D1Database, actor: Actor, action: string, entityType: string, entityId: string, data: unknown): D1PreparedStatement { return stmt(db, 'INSERT INTO AuditEvent (id,actorId,action,entityType,entityId,data,createdAt) VALUES (?,?,?,?,?,?,?)', [uuid(),actor.id,action,entityType,entityId,JSON.stringify(data),now()]); }
function insert(db: D1Database, table: string, values: Row) { const fields = Object.keys(values); return stmt(db, `INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`, fields.map(k => values[k])); }
function update(db: D1Database, table: string, key: string, values: Row) { const fields = Object.keys(values); return stmt(db, `UPDATE ${table} SET ${fields.map(k=>`${k} = ?`).join(',')} WHERE id = ?`, [...fields.map(k => typeof values[k] === 'boolean' ? Number(values[k]) : values[k]),key]); }
async function get(db: D1Database, table: string, key: string, columns = '*'): Promise<Row> { const value = await first<Row>(db, `SELECT ${columns} FROM ${table} WHERE id = ?`, [key]); if (!value) fail(404, 'Запись не найдена'); return value; }
async function ownerVehicles(db: D1Database, rows: Row[], actor: Actor): Promise<Row[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map(r=>r.customerId))];
  const s = scope(actor,'Customer','c');
  const owners: Row[] = [];
  for (let offset=0;offset<ids.length;offset+=90) {
    const chunk=ids.slice(offset,offset+90);
    owners.push(...await all<Row>(db, `SELECT c.* FROM Customer c WHERE c.id IN (${chunk.map(()=>'?').join(',')}) AND ${s.sql}`, [...chunk,...s.args]));
  }
  const map = new Map(owners.map(c=>[c.id,customerDTO(c,actor)]));
  return rows.map(v=>({...v, customerId:map.has(v.customerId) ? v.customerId : '', customer:map.get(v.customerId) ?? null, ...(actor.role === 'MASTER' ? {comment:''} : {})}));
}
const totals = calculateTotals;
async function history(db: D1Database, actor: Actor, field: 'customerId'|'vehicleId', key: string, request: Request): Promise<Row[]> {
  const dates = dateFilter(request, 'o.openedAt');
  const orderWhere = `o.${field} = ? AND ${dates.sql}${actor.role === 'MASTER' ? ' AND o.masterId = ?' : ''}`;
  const orderArgs = [key,...dates.args,...(actor.role === 'MASTER' ? [actor.id] : [])];
  const orders = await all<Row>(db, financeCTE + ` SELECT o.*,f.paidCents ledgerPaidCents FROM WorkOrder o JOIN finances f ON f.id=o.id WHERE ${orderWhere} ORDER BY o.openedAt DESC,o.id`, orderArgs);
  if (!orders.length) return [];
  const [snapshots,lines,customers,vehicles,masters] = await Promise.all([
    all<LegacyFinancialSnapshot>(db,`SELECT s.* FROM LegacyFinancialSnapshot s JOIN WorkOrder o ON o.id=s.orderId WHERE ${orderWhere}`,orderArgs),
    all<Row>(db,`SELECT l.* FROM OrderLine l JOIN WorkOrder o ON o.id=l.orderId WHERE ${orderWhere}`,orderArgs),
    all<Row>(db,`SELECT DISTINCT c.* FROM Customer c JOIN WorkOrder o ON o.customerId=c.id WHERE ${orderWhere}`,orderArgs),
    all<Row>(db,`SELECT DISTINCT v.* FROM Vehicle v JOIN WorkOrder o ON o.vehicleId=v.id WHERE ${orderWhere}`,orderArgs),
    all<Row>(db,`SELECT DISTINCT u.id,u.name FROM User u JOIN WorkOrder o ON o.masterId=u.id WHERE ${orderWhere}`,orderArgs),
  ]);
  const customerMap=new Map(customers.map(c=>[c.id,c])),vehicleMap=new Map(vehicles.map(v=>[v.id,v])),masterMap=new Map(masters.map(m=>[m.id,{id:m.id,name:m.name}]));
  const snapshotMap = new Map(snapshots.map(s=>[s.orderId,s]));
  const linesByOrder = new Map<string,OrderDetail['lines']>();
  for(const row of lines){
    const group = linesByOrder.get(row.orderId) ?? [];
    group.push({...row,completed:!!row.completed} as OrderDetail['lines'][number]);
    linesByOrder.set(row.orderId,group);
  }
  return orders.map(({ledgerPaidCents,...o})=>{
    const orderLines = linesByOrder.get(o.id) ?? [], v=vehicleMap.get(o.vehicleId), c=customerMap.get(o.customerId);
    const isMaster = actor.role==='MASTER';
    return {...o, customer:c ? customerDTO(c,actor) : null, vehicle:isMaster ? {...v,customerId:'',comment:''} : v,
      master:masterMap.get(o.masterId) ?? null, lines:isMaster ? orderLines.map(l=>({...l,unitPriceCents:0})) : orderLines,
      discountCents:isMaster ? 0 : o.discountCents, paidCents:isMaster ? 0 : ledgerPaidCents,
      ...(isMaster ? {documents:[]} : {}),
      totals:isMaster ? totals([]) : totalsForOrder({lines:orderLines,status:o.status,discountCents:o.discountCents,
        paidCents:ledgerPaidCents,financialMode:o.financialMode,legacySnapshot:snapshotMap.get(o.id)}),
    };
  });
}

export async function handleCrud(ctx: Context): Promise<Response|null> {
  const { request, env:{DB:db}, actor } = ctx;
  const path = new URL(request.url).pathname;
  const match = /^\/api\/(customers|vehicles|staff|catalog|settings)(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  const resource=match[1], key=match[2] ? decodeURIComponent(match[2]) : undefined, method=request.method;
  if(resource==='customers' || resource==='vehicles') {
    const table=resource==='customers' ? 'Customer' : 'Vehicle';
    if(method==='GET' && !key) {
      const {q,page,pageSize}=pagination(request), s=scope(actor,table,'t');
      let where=s.sql; const args=[...s.args];
      const dates=dateFilter(request,'o.openedAt');
      const relation=table==='Customer'?'customerId':'vehicleId';
      const masterScope=actor.role==='MASTER'?' AND o.masterId=?':'';
      const masterArgs=actor.role==='MASTER'?[actor.id]:[];
      if(dates.args.length){
        where+=` AND EXISTS (SELECT 1 FROM WorkOrder o WHERE o.${relation}=t.id AND ${dates.sql}${masterScope})`;
        args.push(...dates.args,...masterArgs);
      }
      if(q){
        const like='%'+q+'%',digits=q.replace(/\D/g,'');
        const customerMatch=(alias:string)=>`(${alias}.name LIKE ? OR ${alias}.phone LIKE ? OR ${alias}.phoneNormalized LIKE ? OR ${alias}.email LIKE ?)`;
        const customerArgs=[like,like,'%'+(digits || q)+'%',like];
        const carMatch=(alias:string)=>`(${alias}.make LIKE ? OR ${alias}.model LIKE ? OR ${alias}.vin LIKE ? OR ${alias}.plate LIKE ?)`;
        const carArgs=[like,like,like,like];
        const orderMatch=`EXISTS (SELECT 1 FROM WorkOrder o JOIN Customer c ON c.id=o.customerId JOIN Vehicle v ON v.id=o.vehicleId
          WHERE o.${relation}=t.id AND (o.number LIKE ? OR ${table==='Customer'?carMatch('v'):customerMatch('c')})${masterScope})`;
        if(table==='Customer'){
          const carScope=scope(actor,'Vehicle','v');
          where+=` AND (${customerMatch('t')} OR EXISTS (SELECT 1 FROM Vehicle v WHERE v.customerId=t.id AND ${carMatch('v')} AND ${carScope.sql}) OR ${orderMatch})`;
          args.push(...customerArgs,...carArgs,...carScope.args,like,...carArgs,...masterArgs);
        }else{
          const ownerScope=scope(actor,'Customer','c');
          where+=` AND (${carMatch('t')} OR EXISTS (SELECT 1 FROM Customer c WHERE c.id=t.customerId AND ${customerMatch('c')} AND ${ownerScope.sql}) OR ${orderMatch})`;
          args.push(...carArgs,...customerArgs,...ownerScope.args,like,...customerArgs,...masterArgs);
        }
      }
      const rows=await all<Row>(db,`SELECT t.* FROM ${table} t WHERE ${where} ORDER BY ${table==='Customer'?'t.name':'t.createdAt DESC'},t.id LIMIT ? OFFSET ?`,[...args,pageSize,(page-1)*pageSize]);
      const total=await first<{total:number}>(db,`SELECT COUNT(*) total FROM ${table} t WHERE ${where}`,args);
      return json({items:table==='Vehicle' ? await ownerVehicles(db,rows,actor) : rows.map(r=>customerDTO(r,actor)), total:total?.total??0,page,pageSize});
    }
    if(method==='GET' && key) {
      const s=scope(actor,table,'t'),value=await first<Row>(db,`SELECT t.* FROM ${table} t WHERE t.id=? AND ${s.sql}`,[key,...s.args]);
      if(!value) fail(404,table==='Customer'?'Клиент не найден':'Автомобиль не найден');
      const orders=await history(db,actor,table==='Customer'?'customerId':'vehicleId',key,request);
      if(table==='Customer') {const v=scope(actor,'Vehicle','v'); const vehicles=await all<Row>(db,`SELECT v.* FROM Vehicle v WHERE v.customerId=? AND ${v.sql}`,[key,...v.args]);return json({...customerDTO(value,actor),vehicles:await ownerVehicles(db,vehicles,actor),orders});}
      const c=scope(actor,'Customer','c'); const ownerships=await all<Row>(db,`SELECT own.* FROM VehicleOwnership own JOIN Customer c ON c.id=own.customerId WHERE own.vehicleId=? AND ${c.sql} ORDER BY own.startedAt DESC`,[key,...c.args]);
      const owners=await all<Row>(db,`SELECT c.* FROM Customer c WHERE c.id IN (SELECT customerId FROM VehicleOwnership WHERE vehicleId=?) AND ${c.sql}`,[key,...c.args]);const ownerMap=new Map(owners.map(o=>[o.id,customerDTO(o,actor)]));
      return json({...((await ownerVehicles(db,[value],actor))[0]),orders,ownerships:ownerships.map(o=>({...o,customer:ownerMap.get(o.customerId)??null}))});
    }
    if((method==='POST' && !key) || (method==='PATCH' && key)) {
      requireRole(actor,'ADMIN','RECEPTION');
      const input:Row = (table==='Customer' ? (key?customerPatch:customerCreate) : (key?vehiclePatch:vehicleCreate)).parse(await body(request));
      const time=now(), entityId=key??uuid(),before=key?await get(db,table,key):null;
      const {archived,...fields}=input;
      if(table==='Customer' && fields.phone) fields.phoneNormalized=fields.phone.replace(/\D/g,'');
      const statements:D1PreparedStatement[]=[];
      let condition='SELECT 1',conditionArgs:unknown[]=[];
      if(table==='Vehicle') {
        if(before && fields.mileage!==undefined && fields.mileage<before.mileage) fail(422,'Пробег не может быть меньше последнего зафиксированного');
        const owner=fields.customerId ?? before?.customerId;
        if(!before || (fields.customerId && fields.customerId!==before.customerId)) {
          if(!await first(db,'SELECT id FROM Customer WHERE id=? AND archivedAt IS NULL',[owner])) fail(422,'Выберите активного клиента');
          condition='SELECT EXISTS(SELECT 1 FROM Customer WHERE id=? AND archivedAt IS NULL)';conditionArgs=[owner];
          if(before) { statements.push(stmt(db,'UPDATE VehicleOwnership SET endedAt=? WHERE vehicleId=? AND endedAt IS NULL',[time,key]),audit(db,actor,'OWNER_CHANGE','Vehicle',entityId,{from:before.customerId,to:owner})); }
        }
        if(before) { condition=`SELECT (${condition}) AND EXISTS(SELECT 1 FROM Vehicle WHERE id=? AND customerId=? AND mileage=? AND updatedAt=?)`;conditionArgs.push(entityId,before.customerId,before.mileage,before.updatedAt); }
      }
      if(archived!==undefined) fields.archivedAt=archived?time:null;
      fields.updatedAt=time;
      if(key) statements.push(update(db,table,key,fields));
      else statements.unshift(insert(db,table,{...(table==='Customer'?{email:null,comment:'',archivedAt:null}:{year:null,vin:null,plate:null,engine:'',comment:'',archivedAt:null}),...fields,id:entityId,createdAt:time}));
      if(table==='Vehicle' && (!before || (fields.customerId && fields.customerId!==before.customerId))) statements.push(insert(db,'VehicleOwnership',{id:uuid(),vehicleId:entityId,customerId:fields.customerId,startedAt:time,endedAt:null}));
      statements.push(audit(db,actor,!key?'CREATE':archived===undefined?'UPDATE':archived?'ARCHIVE':'RESTORE',table,entityId,{fields:Object.keys(input)}));
      await guarded(db,condition,conditionArgs,statements);
      return json(await get(db,table,entityId),key?200:201);
    }
  }
  if(resource==='staff') {
    if(method==='GET' && !key) return json({items:(await all<Row>(db,`SELECT ${staffColumns} FROM User${actor.role==='MASTER'?" WHERE role='MASTER' AND active=1":''} ORDER BY name,id`)).map(bools)});
    if(method==='POST' && !key) {
      requireRole(actor,'ADMIN','RECEPTION');
      const input=staffCreate.parse(await body(request)),entityId=uuid();
      if(input.role!=='MASTER') requireRole(actor,'ADMIN');
      const email='email' in input ? input.email : 'directory:'+entityId;
      await batch(db,[insert(db,'User',{id:entityId,...input,email,active:1,providerId:null,createdAt:now()}),audit(db,actor,'CREATE','User',entityId,{role:input.role})]);
      return json(bools(await get(db,'User',entityId,staffColumns)),201);
    }
    if(method==='PATCH' && key) {requireRole(actor,'ADMIN');const input=staffPatch.parse(await body(request)),before=await get(db,'User',key,staffColumns);const removing=before.role==='ADMIN' && !!before.active && ((input.role!==undefined && input.role!=='ADMIN') || input.active===false);
      if(removing && ((await first<{n:number}>(db,"SELECT COUNT(*) n FROM User WHERE role='ADMIN' AND active=1"))?.n??0)<=1) fail(409,'Нельзя отключить или изменить роль последнего активного администратора');
      await guarded(db,`SELECT EXISTS(SELECT 1 FROM User WHERE id=? AND name=? AND role=? AND active=?)${removing?" AND (SELECT COUNT(*) FROM User WHERE role='ADMIN' AND active=1)>1":''}`,[key,before.name,before.role,before.active],[update(db,'User',key,input),audit(db,actor,'UPDATE','User',key,{fields:Object.keys(input)})]);return json(bools(await get(db,'User',key,staffColumns)));}
  }
  if(resource==='catalog') {
    if(method==='GET' && !key) return json({items:(await all<Row>(db,'SELECT * FROM CatalogItem ORDER BY sortOrder,category,name,id')).map(bools)});
    if((method==='POST' && !key)||(method==='PATCH' && key)) {requireRole(actor,'ADMIN');const input=(key?catalogPatch:catalogCreate).parse(await body(request)),entityId=key??uuid(),before=key?await get(db,'CatalogItem',key):null;await batch(db,[key?update(db,'CatalogItem',key,input):insert(db,'CatalogItem',{id:entityId,unit:'шт.',laborPriceCents:0,active:1,sortOrder:0,...input}),audit(db,actor,key?'UPDATE':'CREATE','CatalogItem',entityId,{...input,...(before && input.laborPriceCents!==undefined?{previousLaborPriceCents:before.laborPriceCents}:{})})]);return json(bools(await get(db,'CatalogItem',entityId)),key?200:201);}
  }
  if(resource==='settings' && !key) {
    if(method==='GET') {requireRole(actor,'ADMIN','RECEPTION');return json(await get(db,'ServiceSettings','main'));}
    if(method==='PATCH') {requireRole(actor,'ADMIN');const input=settingsPatch.parse(await body(request));await batch(db,[update(db,'ServiceSettings','main',input),audit(db,actor,'UPDATE','ServiceSettings','main',input)]);return json(await get(db,'ServiceSettings','main'));}
  }
  return null;
}
