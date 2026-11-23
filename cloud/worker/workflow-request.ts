import { z } from 'zod';
import { first, stmt } from './db';
import { fail, json } from './common';
import { loadOrder } from './orders';
import type { OrderDetail } from '../shared/types';
import type { Context, D1PreparedStatement } from './types';

export const requestIdField = z.string().trim().min(1).max(160);

// Callers supply schema-parsed objects with deterministic field order.
export async function withRequest(ctx: Context, operation: string, requestId: string, payload: unknown,
  commit: (record: (orderId: string, resultId: string) => D1PreparedStatement) => Promise<string>, status = 200,
  result: (order: OrderDetail, resultId: string) => unknown = order => order) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = [ctx.actor.id, operation, requestId];
  const replay = async () => {
    const row = await first<{orderId: string; resultId: string; payloadHash: string}>(ctx.env.DB,
      'SELECT orderId,resultId,payloadHash FROM WorkflowRequest WHERE actorId=? AND operation=? AND requestId=?', key);
    if (!row) return null;
    if (row.payloadHash !== hash) fail(409, 'Этот ключ уже использован для другого запроса');
    return json(result(await loadOrder(ctx, row.orderId), row.resultId));
  };
  const existing = await replay();
  if (existing) return existing;
  let orderId: string;
  let committedId: string | undefined;
  try {
    orderId = await commit((orderId, resultId) => {
      committedId = resultId;
      return stmt(ctx.env.DB,
      'INSERT INTO WorkflowRequest(actorId,operation,requestId,payloadHash,orderId,resultId) VALUES(?,?,?,?,?,?)',
      [...key, hash, orderId, resultId]);
    });
  } catch (error) {
    const concurrent = await replay();
    if (concurrent) return concurrent;
    throw error;
  }
  if (!committedId) throw new Error('Ключ запроса не сохранён');
  return json(result(await loadOrder(ctx, orderId), committedId), status);
}
