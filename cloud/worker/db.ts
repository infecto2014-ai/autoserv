import { fail } from './common';
import type { D1Database, D1PreparedStatement, D1Result } from './types';
export function stmt(db: D1Database, sql: string, args: unknown[] = []): D1PreparedStatement { return db.prepare(sql).bind(...args); }
export async function all<T>(db: D1Database, sql: string, args: unknown[] = []): Promise<T[]> { return (await stmt(db, sql, args).all<T>()).results; }
export function first<T>(db: D1Database, sql: string, args: unknown[] = []): Promise<T | null> { return stmt(db, sql, args).first<T>(); }
export function run(db: D1Database, sql: string, args: unknown[] = []): Promise<D1Result> { return stmt(db, sql, args).run(); }
export function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> { return db.batch(statements); }
export function uuid(): string { return crypto.randomUUID(); }
export function now(): string { return new Date().toISOString(); }
/** D1 batch is atomic. A named CHECK aborts every write on a stale precondition. */
export async function guarded(db: D1Database, conditionSQL: string, conditionArgs: unknown[], statements: D1PreparedStatement[]): Promise<void> {
  const key = uuid();
  try {
    await batch(db, [
      stmt(db, 'INSERT INTO MutationGuard (key, ok) VALUES (?, COALESCE((' + conditionSQL + '), 0))', [key, ...conditionArgs]),
      ...statements,
      stmt(db, 'DELETE FROM MutationGuard WHERE key = ?', [key]),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message + ' ' + String(error.cause ?? '') : String(error);
    if (/mutation_guard/i.test(detail)) fail(409, 'Данные изменились. Обновите страницу и повторите действие');
    throw error;
  }
}
