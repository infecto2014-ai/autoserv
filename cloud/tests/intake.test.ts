import { afterEach, expect, it } from 'vitest';
import { SQLiteD1 } from './sqlite-adapter';
import { handleApi } from '../worker/api';
import type { OrderDetail } from '../shared/types';

const db = new SQLiteD1();
afterEach(() => db.close());
const input = {requestId: 'one', make: 'Лада', complaint: 'Стук', phone: '+79001234567'};
it('creates the minimum visit atomically, replays concurrent submissions and requires explicit identity selection', async () => {
  async function post(data: unknown, status: number | number[], authenticated = true) {
    const response = await handleApi(new Request('https://crm.test/api/intake', {method: 'POST', body: JSON.stringify(data),
      headers: {origin: 'https://crm.test', 'content-type': 'application/json', ...(authenticated ? {'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test'} : {})}}),
      {DB: db}, {regular: new Uint8Array(), bold: new Uint8Array()});
    const result = await response.json(); expect(Array.isArray(status) ? status : [status], JSON.stringify(result)).toContain(response.status); return result as OrderDetail;
  }
  await post(input, 401, false);
  const [first, simultaneous] = await Promise.all([post(input,[200,201]),post(input,[200,201])]);
  expect(first.id).toBe(simultaneous.id);
  expect(first.inspectionItems).toHaveLength(110);
  expect((await post(input, 200)).id).toBe(first.id);
  await post({...input, make: 'УАЗ'}, 409);
  const second = await post({...input, requestId: 'two'}, 201);
  expect(second.vehicleId).not.toBe(first.vehicleId);
  expect(second.customerId).not.toBe(first.customerId);
  const third = await post({...input, requestId: 'three', vehicleId: first.vehicleId}, 201);
  expect(third.customerId).toBe(first.customerId);
  await post({...input, requestId: 'four', customerId: second.customerId, vehicleId: first.vehicleId}, 409);
  expect(db.sqlite.prepare('SELECT count(*) n FROM WorkOrder').get()).toMatchObject({n: 3});
});
