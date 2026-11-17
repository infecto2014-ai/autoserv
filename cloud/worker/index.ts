import {handleApi} from './api';
import type {Env} from './types';
interface Assets {html:string;js:string;css:string;regular:string;bold:string}
const security={
 'x-content-type-options':'nosniff',
 'referrer-policy':'same-origin',
 'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com",
};
function decode(value:string){const text=atob(value);return Uint8Array.from(text,x=>x.charCodeAt(0));}
export function createWorker(assets:Assets){
 let fonts:{regular:Uint8Array;bold:Uint8Array}|undefined;
 return {async fetch(request:Request,env:Env):Promise<Response>{
  const path=new URL(request.url).pathname;
  let response:Response;
  if(path.startsWith('/api/')){
   fonts??={regular:decode(assets.regular),bold:decode(assets.bold)};
   response=await handleApi(request,env,fonts);
  }else if(path==='/assets/app.js')response=new Response(assets.js,{headers:{'content-type':'application/javascript; charset=utf-8','cache-control':'no-cache'}});
  else if(path==='/assets/app.css')response=new Response(assets.css,{headers:{'content-type':'text/css; charset=utf-8','cache-control':'no-cache'}});
  else if(path==='/'||path==='/index.html')response=new Response(assets.html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  else response=new Response('Не найдено',{status:404});
  const headers=new Headers(response.headers);for(const[k,v]of Object.entries(security))headers.set(k,v);
  return new Response(response.body,{status:response.status,headers});
 }};
}
