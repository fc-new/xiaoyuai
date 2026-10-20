import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrderStatus } from './catalog.js';

export interface OrderRow {
  id: string; access_hash: string; email: string; contact: string; plan_id: string; plan_name: string;
  amount: number; currency: string; status: OrderStatus; payment_mode: string; stripe_session: string | null;
  checkout_url: string | null; payment_attempt: number; created_at: string; updated_at: string;
}

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, email TEXT NOT NULL, contact TEXT NOT NULL,
      plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL DEFAULT 'cny', status TEXT NOT NULL DEFAULT 'pending_payment',
      payment_mode TEXT NOT NULL, stripe_session TEXT UNIQUE, checkout_url TEXT,
      payment_attempt INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
      status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS merchant_payments (
      order_id TEXT PRIMARY KEY REFERENCES orders(id), channel TEXT NOT NULL CHECK(channel IN ('wechat','alipay')),
      transaction_id TEXT UNIQUE, qr_code TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC);
  `);
  return db;
}
