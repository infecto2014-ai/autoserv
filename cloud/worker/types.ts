import type { Actor } from '../shared/types';
export type { Actor, Role } from '../shared/types';

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: { changes: number; last_row_id?: number; [key: string]: unknown };
  error?: string;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export interface Env { DB: D1Database }
export interface Context {
  request: Request;
  env: Env;
  actor: Actor;
  params: Record<string, string>;
}
