import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteD1 } from './sqlite-adapter';
import { actorFromRequest, ensureDefaults } from '../worker/auth';
import { all, first, guarded, run, stmt } from '../worker/db';
import { body, pagination, requireRole } from '../worker/common';

const databases: SQLiteD1[] = [];
const paths: string[] = [];
function db() { const value = new SQLiteD1(); databases.push(value); return value; }
function request(id = 'owner-id', email = 'owner@example.test', extra: Record<string, string> = {}) {
  return new Request('https://crm.example.test/api/me', { headers: { 'oai-authenticated-user-id': id, 'oai-authenticated-user-email': email, ...extra } });
}
afterEach(() => { for (const value of databases.splice(0)) value.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('SQLite foundation', () => {
  it('seeds 110 editable catalog items once and persists records across reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'crm-db-')); paths.push(directory);
    const filename = join(directory, 'test.sqlite');
    const firstDB = new SQLiteD1(filename);
    await Promise.all([ensureDefaults(firstDB), ensureDefaults(firstDB)]);
    expect((await all(firstDB, 'SELECT id FROM CatalogItem')).length).toBe(110);
    await run(firstDB, "UPDATE CatalogItem SET name = 'Edited', laborPriceCents = 20000 WHERE id = 'seed-000'");
    await run(firstDB, "UPDATE ServiceSettings SET name = 'Saved' WHERE id = 'main'");
    firstDB.close();
    const reopened = new SQLiteD1(filename, false); databases.push(reopened);
    await ensureDefaults(reopened);
    expect(await first(reopened, "SELECT name, laborPriceCents FROM CatalogItem WHERE id='seed-000'")).toMatchObject({ name: 'Edited', laborPriceCents: 20000 });
    expect(await first(reopened, 'SELECT name FROM ServiceSettings')).toMatchObject({ name: 'Saved' });
  });

  it('has no headerless bootstrap; bootstraps one owner and never returns provider IDs', async () => {
    const database = db();
    await expect(actorFromRequest(new Request('https://crm.example.test/api/me'), { DB: database })).rejects.toMatchObject({ status: 401 });
    expect(await all(database, 'SELECT id FROM User')).toHaveLength(0);
    const owner = await actorFromRequest(request('owner-id', 'owner@example.test', {
      'oai-authenticated-user-full-name': encodeURIComponent('Иван Владелец'), 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
    }), { DB: database });
    expect(owner).toMatchObject({ name: 'Иван Владелец', role: 'ADMIN' });
    expect(Object.keys(owner).sort()).toEqual(['email', 'id', 'name', 'role']);
    await expect(actorFromRequest(request('foreign-id', 'other@example.test'), { DB: database })).rejects.toMatchObject({ status: 403 });
    await expect(actorFromRequest(request('foreign-id', 'owner@example.test'), { DB: database })).rejects.toMatchObject({ status: 403 });
    expect((await actorFromRequest(request('owner-id', 'changed@example.test'), { DB: database })).id).toBe(owner.id);
  });

  it('permits only one admin under concurrent bootstrap', async () => {
    const database = db();
    const results = await Promise.allSettled([
      actorFromRequest(request('one', 'one@example.test'), { DB: database }),
      actorFromRequest(request('two', 'two@example.test'), { DB: database }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await all(database, "SELECT id FROM User WHERE role='ADMIN'")).toHaveLength(1);
    expect(await all(database, 'SELECT * FROM MutationGuard')).toHaveLength(0);
  });

  it('claims registered staff once and enforces disabled accounts and roles', async () => {
    const database = db();
    await actorFromRequest(request(), { DB: database });
    await run(database, "INSERT INTO User (id,name,email,role) VALUES ('master','Мастер','master@example.test','MASTER')");
    const staff = await actorFromRequest(request('master-provider', 'MASTER@example.test'), { DB: database });
    expect(staff.role).toBe('MASTER');
    expect(() => requireRole(staff, 'ADMIN', 'RECEPTION')).toThrowError('Недостаточно прав');
    await expect(actorFromRequest(request('foreign-provider', 'master@example.test'), { DB: database })).rejects.toMatchObject({ status: 403 });
    await run(database, "UPDATE User SET active = 0 WHERE id = 'master'");
    await expect(actorFromRequest(request('master-provider', 'master@example.test'), { DB: database })).rejects.toMatchObject({ status: 403 });
    await run(database, "INSERT INTO User (id,name,email,role,active) VALUES ('disabled','Disabled','disabled@example.test','RECEPTION',0)");
    await expect(actorFromRequest(request('disabled-provider', 'disabled@example.test'), { DB: database })).rejects.toMatchObject({ status: 403 });
    expect(await first(database, "SELECT providerId FROM User WHERE id='disabled'")).toMatchObject({ providerId: null });
  });

  it('does not bootstrap when existing staff has no administrator', async () => {
    const database = db();
    await run(database, "INSERT INTO User (id,name,email,role) VALUES ('staff','Staff','staff@example.test','MASTER')");
    await expect(actorFromRequest(request(), { DB: database })).rejects.toMatchObject({ status: 403 });
  });

  it('rolls back stale and failed mutations with no child writes', async () => {
    const database = db();
    const owner = await actorFromRequest(request(), { DB: database });
    await run(database, "INSERT INTO Customer (id,name,phone,phoneNormalized) VALUES ('c','Client','123','123')");
    await run(database, "INSERT INTO Vehicle (id,customerId,make,model) VALUES ('v','c','Make','Model')");
    await run(database, "INSERT INTO WorkOrder (id,number,customerId,vehicleId,mileage,complaint) VALUES ('o','1','c','v',1,'Test')");
    const mutate = (version: number, id: string) => guarded(database, "SELECT COUNT(*)=1 FROM WorkOrder WHERE id='o' AND version=?", [version], [
      stmt(database, "UPDATE WorkOrder SET version=version+1 WHERE id='o'"),
      stmt(database, "INSERT INTO InspectionItem (id,orderId,category,name,authorId) VALUES (?,'o','ТО','Item',?)", [id, owner.id]),
    ]);
    const results = await Promise.allSettled([mutate(0, 'a'), mutate(0, 'b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    expect(await first(database, "SELECT version FROM WorkOrder WHERE id='o'")).toMatchObject({ version: 1 });
    expect(await all(database, 'SELECT id FROM InspectionItem')).toHaveLength(1);
    await expect(mutate(1, 'a')).rejects.toThrow();
    expect(await first(database, "SELECT version FROM WorkOrder WHERE id='o'")).toMatchObject({ version: 1 });
    expect(await all(database, 'SELECT * FROM MutationGuard')).toHaveLength(0);
    await expect(run(database, "DELETE FROM User WHERE id=?", [owner.id])).rejects.toThrow();
    await expect(run(database, "UPDATE WorkOrder SET paidCents=-1 WHERE id='o'")).rejects.toThrow();
    await expect(run(database, "UPDATE WorkOrder SET paidCents=1.5 WHERE id='o'")).rejects.toThrow();
    await expect(run(database, "UPDATE WorkOrder SET status='INVALID' WHERE id='o'")).rejects.toThrow();
    await expect(run(database, "DELETE FROM Customer WHERE id='c'")).rejects.toThrow();
  });

  it('supports transactional last-admin guards', async () => {
    const database = db();
    const owner = await actorFromRequest(request(), { DB: database });
    await expect(guarded(database, "SELECT COUNT(*)>1 FROM User WHERE role='ADMIN' AND active=1", [], [stmt(database, 'UPDATE User SET active=0 WHERE id=?', [owner.id])])).rejects.toMatchObject({ status: 409 });
    expect(await first(database, 'SELECT active FROM User WHERE id=?', [owner.id])).toMatchObject({ active: 1 });
  });
});

describe('request limits', () => {
  it('parses objects, rejects malformed JSON and streams over 1 MiB', async () => {
    expect(await body(new Request('https://crm.example.test', { method: 'POST', body: '{"ok":true}' }))).toEqual({ ok: true });
    await expect(body(new Request('https://crm.example.test', { method: 'POST', body: '[]' }))).rejects.toMatchObject({ status: 400 });
    await expect(body(new Request('https://crm.example.test', { method: 'POST', body: '{' }))).rejects.toMatchObject({ status: 400 });
    await expect(body(new Request('https://crm.example.test', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }))).rejects.toMatchObject({ status: 413 });
    expect(pagination(new Request('https://crm.example.test?q=test&page=2&pageSize=10'))).toEqual({ q: 'test', page: 2, pageSize: 10 });
    expect(() => pagination(new Request('https://crm.example.test?page=-1'))).toThrow();
  });
});
