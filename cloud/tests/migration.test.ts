import { afterEach, expect, it } from "vitest";
import { SQLiteD1 } from "./sqlite-adapter";

const dbs: SQLiteD1[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

it("переносит старый расчёт и PDF, не приписывая оплате дату или согласие", () => {
  const db = new SQLiteD1(":memory:", false);
  dbs.push(db);
  db.migrate("0000_initial");
  db.sqlite.exec(`
    INSERT INTO User(id,name,email) VALUES ('a','Приёмщик','a@example.test');
    INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES ('c','Клиент','','');
    INSERT INTO Vehicle(id,customerId,make,model) VALUES ('v','c','Марка','');
    INSERT INTO WorkOrder(id,number,customerId,vehicleId,mileage,complaint,discountCents,paidCents)
      VALUES ('o','1','c','v',0,'Осмотр',20000,400000), ('empty','2','c','v',0,'Осмотр',0,0);
    INSERT INTO OrderLine(id,orderId,kind,name,quantityMilli,unitPriceCents)
      VALUES ('l','o','LABOR','Работа',1000,419999), ('p','o','PART','Деталь',1000,600000),
             ('r','o','LABOR','Округление',500,1);
    INSERT INTO Document(id,orderId,number,kind,version,snapshot,pdf,sha256,authorId)
      VALUES ('d','o','А1','WORK_ORDER',1,'{"old":true}',x'25504446','test-sha','a');
  `);
  const doc = db.sqlite.prepare("SELECT * FROM Document").get();
  db.migrate();
  db.migrate();
  expect(db.sqlite.prepare("SELECT financialMode FROM WorkOrder WHERE id='o'").get()?.financialMode).toBe("LEGACY");
  expect(db.sqlite.prepare("SELECT * FROM LegacyFinancialSnapshot WHERE orderId='o'").get()).toEqual({
    orderId: "o", laborCents: 420000, partsCents: 600000, subtotalCents: 1020000, discountCents: 20000,
    totalCents: 1000000, paidCents: 400000, balanceCents: 600000, overpaidCents: 0,
  });
  expect(db.sqlite.prepare("SELECT totalCents FROM LegacyFinancialSnapshot WHERE orderId='empty'").get()?.totalCents).toBe(0);
  expect(db.sqlite.prepare("SELECT DISTINCT approval,completed FROM OrderLine").all())
    .toEqual([{ approval: "PENDING", completed: 0 }]);
  expect(db.sqlite.prepare("SELECT orderId,kind,amountCents,laborCents,partsCents,unallocatedCents,occurredAt,actorId FROM Payment").all())
    .toEqual([{ orderId: "o", kind: "OPENING", amountCents: 400000, laborCents: 0, partsCents: 0,
      unallocatedCents: 400000, occurredAt: null, actorId: null }]);
  expect(db.sqlite.prepare("SELECT * FROM Document").get()).toEqual(doc);
  db.sqlite.exec("INSERT INTO WorkOrder(id,number,customerId,vehicleId,mileage,complaint) VALUES ('fresh','3','c','v',0,'Осмотр')");
  expect(db.sqlite.prepare("SELECT financialMode FROM WorkOrder WHERE id='fresh'").get()?.financialMode).toBe("WORKFLOW");
  expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("проверяет разбивку платежа, связь возврата с заказом и ключ повторного запроса", () => {
  const db = new SQLiteD1();
  dbs.push(db);
  db.sqlite.exec(`
    INSERT INTO User(id,name,email) VALUES ('actor','Приёмщик','actor@example.test');
    INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES ('c','Клиент','','');
    INSERT INTO Vehicle(id,customerId,make,model) VALUES ('v','c','Марка','');
    INSERT INTO WorkOrder(id,number,customerId,vehicleId,mileage,complaint)
      VALUES ('o','1','c','v',0,'Осмотр'), ('other','2','c','v',0,'Осмотр');
  `);
  const insert = db.sqlite.prepare(`
    INSERT INTO Payment(id,orderId,kind,amountCents,laborCents,partsCents,unallocatedCents,occurredAt,actorId,relatedPaymentId,reason)
    VALUES (?,?,?,100,?,?,0,?,'actor',?,?)
  `);
  const date = "2026-11-21T10:30:00.000Z";
  insert.run("p", "o", "PAYMENT", 30, 70, date, null, null);
  expect(() => insert.run("bad", "o", "PAYMENT", 40, 70, date, null, null)).toThrow();
  expect(() => insert.run("bad", "o", "PAYMENT", 30, 70, null, null, null)).toThrow();
  expect(() => insert.run("r", "other", "REFUND", 30, 70, date, "p", "Ошибка")).toThrow();
  insert.run("r", "o", "REFUND", 30, 70, date, "p", "Ошибка");
  const request = db.sqlite.prepare(`
    INSERT INTO WorkflowRequest(actorId,operation,requestId,payloadHash,orderId,resultId)
    VALUES ('actor','PAYMENT','request',?,'o','p')
  `);
  request.run("hash");
  expect(() => request.run("different-hash")).toThrow();
});
