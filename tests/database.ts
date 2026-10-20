import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Integration tests only accept a local disposable PostgreSQL server. Each
// fixture uses its own schema; no application or production tables are reset.
export async function testDatabase() {
  const folder = mkdtempSync(join(tmpdir(), 'xiaoyuai-test-'));
  const databasePath = join(folder, 'orders.sqlite');
  if (!process.env.TEST_DATABASE_URL) return { config: { databasePath, voucherSecret: 'a1'.repeat(32) }, cleanup: async () => rmSync(folder, { recursive: true, force: true }) };
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('TEST_DATABASE_URL must target a disposable loopback PostgreSQL server');
  const pool = new pg.Pool({ connectionString: url.toString() });
  const schema = `xy_test_${randomBytes(12).toString('hex')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { config: { databasePath, voucherSecret: 'a1'.repeat(32), databaseUrl: url.toString() }, cleanup: async () => {
    try { await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); rmSync(folder, { recursive: true, force: true }); }
  } };
}
