import {z} from 'zod';
import {body, fail, requireRole} from './common';
import {first, guarded, now, stmt, uuid} from './db';
import {createOrderWrites} from './orders';
import {requestIdField, withRequest} from './workflow-request';
import type {Context, D1PreparedStatement} from './types';
import type {Vehicle} from '../shared/types';
import {vehicleCreate, customerCreate} from './crud';

const inputSchema = z.strictObject({
  requestId: requestIdField, make: vehicleCreate.shape.make, model: z.string().trim().max(100).optional(),
  phone: customerCreate.shape.phone, name: z.string().trim().max(200).optional(),
  vin: vehicleCreate.shape.vin, plate: vehicleCreate.shape.plate, mileage: vehicleCreate.shape.mileage.optional(),
  masterId: requestIdField.nullable().optional(), complaint: z.string().trim().min(1).max(5000),
  customerId: requestIdField.optional(), vehicleId: requestIdField.optional(),
});

export async function intake(ctx: Context) {
  requireRole(ctx.actor, 'ADMIN', 'RECEPTION');
  const input = inputSchema.parse(await body(ctx.request));
  return withRequest(ctx, 'INTAKE', input.requestId, input, async record => {
    const db = ctx.env.DB, writes: D1PreparedStatement[] = [], checks: string[] = ['1'], args: unknown[] = [];
    const check = (sql: string, ...values: unknown[]) => { checks.push('EXISTS (' + sql + ')'); args.push(...values); };
    const vehicle = input.vehicleId ? await first<Vehicle>(db, 'SELECT * FROM Vehicle WHERE id=? AND archivedAt IS NULL', [input.vehicleId]) : null;
    if (input.vehicleId && !vehicle) fail(404, 'Активный автомобиль не найден');
    if (vehicle && input.customerId && input.customerId !== vehicle.customerId) fail(409, 'Выбран другой владелец автомобиля');
    const customerId = vehicle?.customerId ?? input.customerId ?? uuid();
    const vehicleId = vehicle?.id ?? uuid(), mileage = input.mileage ?? vehicle?.mileage ?? 0;
    if (vehicle || input.customerId) {
      check('SELECT 1 FROM Customer WHERE id=? AND archivedAt IS NULL', customerId);
    } else {
      writes.push(stmt(db, 'INSERT INTO Customer(id,name,phone,phoneNormalized) VALUES(?,?,?,?)',
        [customerId, input.name ?? '', input.phone, input.phone.replace(/\D/g, '')]));
    }
    if (vehicle) {
      if (mileage < vehicle.mileage) fail(422, 'Пробег меньше последнего зафиксированного');
      check('SELECT 1 FROM Vehicle WHERE id=? AND customerId=? AND mileage<=? AND archivedAt IS NULL', vehicleId, customerId, mileage);
    } else {
      writes.push(stmt(db, 'INSERT INTO Vehicle(id,customerId,make,model,vin,plate,mileage) VALUES(?,?,?,?,?,?,?)',
        [vehicleId, customerId, input.make, input.model ?? '', input.vin ?? null, input.plate || null, mileage]),
        stmt(db, 'INSERT INTO VehicleOwnership(id,vehicleId,customerId) VALUES(?,?,?)', [uuid(), vehicleId, customerId]));
    }
    if (input.masterId) check("SELECT 1 FROM User WHERE id=? AND active=1 AND role='MASTER'", input.masterId);
    const id = uuid();
    writes.push(...createOrderWrites(ctx, id, customerId, vehicleId, mileage, input.complaint, input.masterId ?? null, now()), record(id, id));
    await guarded(db, 'SELECT ' + checks.join(' AND '), args, writes);
    return id;
  }, 201);
}
