import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import journal from '../drizzle/meta/_journal.json';
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/types';

function sqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new TypeError('Unsupported SQL binding: ' + typeof value);
}
class SQLiteStatement implements D1PreparedStatement {
  constructor(private readonly db: DatabaseSync, readonly sql: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]): SQLiteStatement { return new SQLiteStatement(this.db, this.sql, values); }
  execute<T>(): D1Result<T> {
    const statement = this.db.prepare(this.sql);
    const values = this.values.map(sqlValue);
    const returnsRows = statement.columns().length > 0;
    const results = returnsRows ? statement.all(...values) as T[] : [];
    const info = returnsRows ? { changes: 0, lastInsertRowid: 0 } : statement.run(...values);
    return { success: true, results, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values.map(sqlValue));
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all<T>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async run<T>(): Promise<D1Result<T>> { return this.execute<T>(); }
}
/** Real SQLite, with D1's all-or-nothing batch semantics; no hosted auth bypass. */
export class SQLiteD1 implements D1Database {
  readonly sqlite: DatabaseSync;
  constructor(filename = ':memory:', migrate = true) {
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec('PRAGMA busy_timeout = 5000');
    if (migrate) this.migrate();
  }
  migrate(throughTag?: string): void {
    if (throughTag && !journal.entries.some(entry => entry.tag === throughTag))
      throw new Error('Неизвестная миграция: ' + throughTag);
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
    const applied = this.sqlite.prepare('SELECT 1 FROM d1_migrations WHERE name=?');
    const record = this.sqlite.prepare('INSERT INTO d1_migrations(name) VALUES (?)');
    for (const entry of journal.entries) {
      const name = entry.tag + '.sql';
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        if (!applied.get(name)) {
          this.sqlite.exec(readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
          record.run(name);
        }
        this.sqlite.exec('COMMIT');
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
      if (entry.tag === throughTag) break;
    }
  }
  prepare(sql: string): D1PreparedStatement { return new SQLiteStatement(this.sqlite, sql); }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(statement => {
        if (!(statement instanceof SQLiteStatement)) throw new TypeError('Foreign statement');
        return statement.execute<T>();
      });
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.sqlite.close(); }
}
export function createTestDB(filename = ':memory:'): SQLiteD1 { return new SQLiteD1(filename); }
