import {expect,it} from 'vitest';
import {overview} from '../worker/overview';
import type {Actor} from '../worker/types';
import {SQLiteD1} from './sqlite-adapter';

it('keeps active groups and debt current and filters completions by the first delivery in UTC+2',async()=>{
  const db = new SQLiteD1();
  try {
    db.sqlite.exec(`INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES ('c','','12345','12345');
      INSERT INTO Vehicle(id,customerId,make,model) VALUES('v','c','Марка','');`);
    const insert=db.sqlite.prepare("INSERT INTO WorkOrder(id,number,customerId,vehicleId,mileage,complaint,status,openedAt,closedAt) VALUES(?,?,'c','v',0,'Осмотр',?,'2020-01-01T00:00:00.000Z',?)");
    for(const [i,status] of ['NEW','DIAGNOSTICS','IN_PROGRESS','APPROVAL','READY','CANCELLED','DELIVERED','DELIVERED'].entries())
      insert.run(String(i),String(i),status,i===6?'2026-10-31T21:59:59.999Z':i===7?'2026-10-31T22:00:00.000Z':null);
    db.sqlite.exec("INSERT INTO OrderLine(id,orderId,kind,name,unitPriceCents,approval,completed) VALUES('l','7','LABOR','Диагностика',300,'APPROVED',1)");
    const actor:Actor={role:'RECEPTION',id:'a',name:'А',email:'a@example.test'};
    const context=(query:string)=>({request:new Request('https://crm.test/api/overview?'+query),env:{DB:db},params:{},actor});
    const nov=await (await overview(context('from=2026-11-01&to=2026-11-01'))).json();
    expect(nov).toMatchObject({counts:{active:3,approval:1,ready:1,completed:1},money:{debtCents:300,totalCents:0}});
    expect(await (await overview(context('to=2026-10-01'))).json()).toMatchObject({counts:{completed:0,active:3},money:{debtCents:300}});
    await expect(overview(context('from=2026-02-30'))).rejects.toMatchObject({status:422});
    await expect(overview(context('from=2026-03-01&to=2026-02-28'))).rejects.toMatchObject({status:422});
    await expect(overview({...context(''),actor:{...actor,role:'MASTER'}})).rejects.toMatchObject({status:403});
  } finally {db.close();}
});
