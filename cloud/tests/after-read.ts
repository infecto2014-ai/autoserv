import type { D1PreparedStatement } from '../worker/types';
import type { SQLiteD1 } from './sqlite-adapter';

// Simulate another committed write immediately after a selected read transaction.
// D1 batch has one transaction boundary for all its statements.
export function afterRead(db: SQLiteD1, matches: RegExp, write: () => void) {
  let fired = false;
  const fire = () => { if (!fired) { fired = true; write(); } };
  const selected = new Set<D1PreparedStatement>();
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!matches.test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args);
      selected.add(bound);
      const all = bound.all.bind(bound), first = bound.first.bind(bound);
      bound.all = async <T>() => {const result = await all<T>(); fire(); return result;};
      bound.first = async <T>(col?:string) => {const result = await first<T>(col); fire(); return result;};
      return bound;
    };
    return statement;
  };
  db.batch = async <T>(statements: D1PreparedStatement[]) => {
    const rows = await batch<T>(statements);
    if (statements.some(s=>selected.has(s))) fire();
    return rows;
  };
  return () => fired;
}
