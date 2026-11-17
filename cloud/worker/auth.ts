import { inspectionGroups } from '../shared/catalog';
import { batch, first, guarded, now, stmt, uuid } from './db';
import { fail, HttpError } from './common';
import type { Actor, D1Database, Env, Role } from './types';

interface IdentityRow extends Actor { providerId: string | null; active: number; role: Role }
const columns = 'id, providerId, name, email, role, active';
function actor(row: IdentityRow): Actor {
  if (!row.active) fail(403, 'Учётная запись отключена');
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}
/** Data initialization only: schema is owned exclusively by migrations. */
export async function ensureDefaults(db: D1Database): Promise<void> {
  if (await first(db, "SELECT key FROM AppMeta WHERE key = 'initialized-v1'")) return;
  const statements = [stmt(db, "INSERT OR IGNORE INTO ServiceSettings (id) VALUES ('main')")];
  let position = 0;
  // Stable IDs and INSERT OR IGNORE make concurrent startup safe and preserve edits.
  // At most 100 bound parameters per statement; keep startup below D1 query limits.
  const rows: unknown[][] = [];
  for (const [category, names] of Object.entries(inspectionGroups)) {
    for (const name of names) {
      const sortOrder = position++;
      rows.push(['seed-' + sortOrder.toString().padStart(3, '0'), category, name, sortOrder]);
    }
  }
  for (let offset = 0; offset < rows.length; offset += 25) {
    const chunk = rows.slice(offset, offset + 25);
    statements.push(stmt(db, 'INSERT OR IGNORE INTO CatalogItem (id, category, name, sortOrder) VALUES ' + chunk.map(() => '(?, ?, ?, ?)').join(','), chunk.flat()));
  }
  statements.push(stmt(db, "INSERT OR IGNORE INTO AppMeta (key, value) VALUES ('initialized-v1', ?)", [now()]));
  await batch(db, statements);
}
/** Only Sites dispatch may inject these identity headers. Never expose this Worker directly. */
export async function actorFromRequest(request: Request, env: Env): Promise<Actor> {
  const providerId = request.headers.get('oai-authenticated-user-id')?.trim();
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if (!providerId || !email || providerId.length > 512 || email.length > 320) fail(401, 'Войдите через ChatGPT');
  const db = env.DB;
  const existing = await first<IdentityRow>(db, `SELECT ${columns} FROM User WHERE providerId = ?`, [providerId]);
  if (existing) return actor(existing);

  const staff = await first<IdentityRow>(db, `SELECT ${columns} FROM User WHERE email = ? COLLATE NOCASE`, [email]);
  if (staff) {
    if (!staff.active || staff.providerId !== null) fail(403, 'Нет доступа к сервису');
    try {
      await guarded(db, 'SELECT COUNT(*) = 1 FROM User WHERE id = ? AND providerId IS NULL AND active = 1 AND email = ? COLLATE NOCASE', [staff.id, email], [
        stmt(db, 'UPDATE User SET providerId = ? WHERE id = ? AND providerId IS NULL', [providerId, staff.id]),
      ]);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409)) throw error;
    }
    const claimed = await first<IdentityRow>(db, `SELECT ${columns} FROM User WHERE providerId = ?`, [providerId]);
    if (claimed) return actor(claimed);
    fail(403, 'Нет доступа к сервису');
  }

  // Owner-private Sites admit only their owner. Bootstrap exactly once while User is empty.
  let name = email;
  const fullName = request.headers.get('oai-authenticated-user-full-name');
  if (fullName && request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { name = decodeURIComponent(fullName).trim().slice(0, 200) || email; } catch { /* email fallback */ }
  } else if (fullName) { name = fullName.trim().slice(0, 200) || email; }
  try {
    await guarded(db, 'SELECT COUNT(*) = 0 FROM User', [], [
      stmt(db, "INSERT INTO User (id, providerId, name, email, role, active, createdAt) VALUES (?, ?, ?, ?, 'ADMIN', 1, ?)", [uuid(), providerId, name, email, now()]),
    ]);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 409)) throw error;
  }
  const bootstrapped = await first<IdentityRow>(db, `SELECT ${columns} FROM User WHERE providerId = ?`, [providerId]);
  if (bootstrapped) return actor(bootstrapped);
  fail(403, 'Попросите администратора добавить ваш email в сотрудники');
}
