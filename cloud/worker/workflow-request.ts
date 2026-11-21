import { z } from 'zod';
import { first, stmt } from './db';
import { fail, json } from './common';
import { loadOrder } from './orders';
import type { Context, D1PreparedStatement } from './types';

export const requestIdField = z.string().trim().min(1).max(160);

// Callers supply schema-parsed objects with deterministic field order.
export async function withRequest(ctx: Context, operation: string, requestId: string, payload: unknown,
  commit: (record: (orderId: string, resultId: string) => D1PreparedStatement) => Promise<string>, status = 200) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = [ctx.actor.id, operation, requestId];
  const replay = async () => {
    const row = await first<{orderId: string; payloadHash: string}>(ctx.env.DB,
      'SELECT orderId,payloadHash FROM WorkflowRequest WHERE actorId=? AND operation=? AND requestId=?', key);
    if (!row) return null;
    if (row.payloadHash !== hash) fail(409, 'Этот ключ уже использован для другого запроса');
    return json(await loadOrder(ctx, row.orderId));
  };
  const existing = await replay();
  if (existing) return existing;
  let orderId: string;
  try {
    orderId = await commit((orderId, resultId) => stmt(ctx.env.DB,
      'INSERT INTO WorkflowRequest(actorId,operation,requestId,payloadHash,orderId,resultId) VALUES(?,?,?,?,?,?)',
      [...key, hash, orderId, resultId]));
  } catch (error) {
    const concurrent = await replay();
    if (concurrent) return concurrent;
    throw error;
  }
  return json(await loadOrder(ctx, orderId), status);
}
