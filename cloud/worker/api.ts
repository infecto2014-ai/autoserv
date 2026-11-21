import {ZodError} from 'zod';
import {actorFromRequest,ensureDefaults} from './auth';
import {HttpError,fail,json} from './common';
import {first} from './db';
import {overview} from './overview';
import {postPayment} from './payments';
import {intake} from './intake';
import {handleCrud} from './crud';
import {handleOrders} from './orders';
import {handleDocuments,type FontBytes} from './documents';
import type {Env,Context} from './types';
export async function handleApi(request:Request,env:Env,fonts:FontBytes):Promise<Response>{
 try{
  const url=new URL(request.url);
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){
   if(request.headers.get('origin')!==url.origin)fail(403,'Запрос с другого источника запрещён');
   if(!request.headers.get('content-type')?.startsWith('application/json'))fail(415,'Используйте application/json');
  }
  if(url.pathname==='/api/auth/session'&&!request.headers.get('oai-authenticated-user-id'))return json({user:null,timezone:'Europe/Kaliningrad'});
  const actor=await actorFromRequest(request,env);
  await ensureDefaults(env.DB);
  if(url.pathname==='/api/auth/session'&&request.method==='GET'){
   const settings=await first<{timezone:string}>(env.DB,"SELECT timezone FROM ServiceSettings WHERE id='main'");return json({user:actor,timezone:settings?.timezone??'Europe/Kaliningrad'});
  }
  if(url.pathname==='/api/health'&&request.method==='GET'){await first(env.DB,'SELECT 1 AS ok');return json({service:'sto-crm-cloud',status:'ok'});}
  const match=url.pathname.match(/^\/api\/(?:orders|documents|customers|vehicles|staff|catalog)\/([^/]+)/);
  const ctx:Context={request,env,actor,params:match?{id:decodeURIComponent(match[1])}:{}};
  if(url.pathname==='/api/overview' && request.method==='GET')return await overview(ctx);
  const paymentPath=/^\/api\/orders\/([^/]+)\/payments\/?$/.exec(url.pathname);
  if(paymentPath && request.method==='POST')return await postPayment(ctx,decodeURIComponent(paymentPath[1]));
  if(url.pathname==='/api/intake' && request.method==='POST')return await intake(ctx);
  return await handleDocuments(ctx,fonts)??await handleOrders(ctx)??await handleCrud(ctx)??json({error:'Маршрут не найден'},404);
 }catch(error){
  if(error instanceof HttpError)return json({error:error.message},error.status);
  if(error instanceof ZodError)return json({error:error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')},422);
  const message=error instanceof Error?error.message:String(error);
  if(/UNIQUE constraint failed/i.test(message))return json({error:'Такая запись уже существует. Обновите данные'},409);
  if(/FOREIGN KEY constraint failed|CHECK constraint failed/i.test(message))return json({error:'Данные нарушают ограничения истории или расчётов'},422);
  console.error('CRM API failed',error instanceof Error?error.name:'UnknownError');
  return json({error:'Ошибка сервера. Повторите запрос позднее'},500);
 }
}
