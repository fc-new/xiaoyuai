import type { Store } from './store.js';

// Additive migration: legacy orders deliberately have no purchase_orders row.
export async function migrateCommerce(db: Store) {
  await db.transaction(async tx => {
    if (tx.dialect === 'postgres') await tx.exec('SELECT pg_advisory_xact_lock(818427001)');
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS purchase_orders (
        order_id TEXT PRIMARY KEY REFERENCES orders(id), quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 10),
        unit_price INTEGER NOT NULL CHECK(unit_price>0), service_period TEXT NOT NULL,
        validity_days INTEGER NOT NULL CHECK(validity_days>0), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS voucher_keys (version INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vouchers (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES purchase_orders(order_id), ordinal INTEGER NOT NULL,
        code_hash TEXT NOT NULL UNIQUE, code_encrypted TEXT NOT NULL, key_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('available','reserved','redeemed','frozen','void','expired')),
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, UNIQUE(order_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS redemptions (
        id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL UNIQUE REFERENCES vouchers(id), order_id TEXT NOT NULL REFERENCES orders(id),
        access_hash TEXT NOT NULL, target_email TEXT NOT NULL, contact TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed','review','cancelled')),
        assignee TEXT, delivery_reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_events (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), voucher_id TEXT, redemption_id TEXT,
        action TEXT NOT NULL, actor TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refund_requests (
        order_id TEXT PRIMARY KEY REFERENCES orders(id), external_reference TEXT, verified_reference TEXT UNIQUE,
        requested_at TEXT NOT NULL, verified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS vouchers_order ON vouchers(order_id);
      CREATE INDEX IF NOT EXISTS redemptions_queue ON redemptions(status,created_at);
      CREATE INDEX IF NOT EXISTS commerce_events_order ON commerce_events(order_id,created_at);
      CREATE INDEX IF NOT EXISTS commerce_events_redemption ON commerce_events(redemption_id,created_at);
    `);
    await tx.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?) ON CONFLICT(version) DO NOTHING').run(new Date().toISOString());
  });
}
