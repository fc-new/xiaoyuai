import pg from 'pg';
import { openDatabase, type OrderRow } from './db.js';

type Value = string | number | null;
type Row = Record<string, unknown>;
export interface Statement {
  get<T = Row>(...values: Value[]): Promise<T | undefined>;
  all<T = Row>(...values: Value[]): Promise<T[]>;
  run(...values: Value[]): Promise<void>;
}
export interface Store {
  readonly dialect: 'sqlite' | 'postgres';
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  transaction<T>(work: (tx: Store) => Promise<T>): Promise<T>;
  lockOrder(id: string): Promise<OrderRow | undefined>;
  close(): Promise<void>;
}

const postgresSchema = `
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, email TEXT NOT NULL, contact TEXT NOT NULL,
    plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
    currency TEXT NOT NULL DEFAULT 'cny', status TEXT NOT NULL DEFAULT 'pending_payment',
    payment_mode TEXT NOT NULL, stripe_session TEXT UNIQUE, checkout_url TEXT,
    payment_attempt INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_events (
    id SERIAL PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
    status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS merchant_payments (
    order_id TEXT PRIMARY KEY REFERENCES orders(id), channel TEXT NOT NULL CHECK(channel IN ('wechat','alipay')),
    transaction_id TEXT UNIQUE, qr_code TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC);
`;

export async function openStore(config: { path: string; url?: string; production?: boolean }): Promise<Store> {
  if (!config.url) {
    const sqlite = openDatabase(config.path);
    // SQLite has one connection. Queue whole transactions so another request
    // cannot join an in-flight transaction while its callback awaits a query.
    let pending: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      const result = pending.then(work);
      pending = result.catch(() => {});
      return result;
    };
    const makeStore = (insideTransaction: boolean): Store => {
      const execute = <T>(work: () => Promise<T>) => insideTransaction ? work() : enqueue(work);
      return {
        dialect: 'sqlite',
        prepare(sql) {
          return {
            get: <T>(...values: Value[]) => execute(async () => sqlite.prepare(sql).get(...values) as T | undefined),
            all: <T>(...values: Value[]) => execute(async () => sqlite.prepare(sql).all(...values) as T[]),
            run: (...values) => execute(async () => { sqlite.prepare(sql).run(...values); }),
          };
        },
        exec: sql => execute(async () => { sqlite.exec(sql); }),
        transaction: work => execute(async () => {
          if (insideTransaction) throw new Error('Nested transactions are not supported');
          sqlite.exec('BEGIN IMMEDIATE');
          try { const result = await work(makeStore(true)); sqlite.exec('COMMIT'); return result; }
          catch (error) { sqlite.exec('ROLLBACK'); throw error; }
        }),
        lockOrder(id) { return this.prepare('SELECT * FROM orders WHERE id=?').get<OrderRow>(id); },
        close: () => execute(async () => { sqlite.close(); }),
      };
    };
    return makeStore(false);
  }

  const url = new URL(config.url);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !config.production;
  if (!local && url.searchParams.get('sslmode') === 'disable') throw new Error('Remote PostgreSQL requires verified TLS');
  // pg parses sslmode=require as a weaker TLS configuration. Configure verified
  // TLS explicitly instead; never allow URL options to override verification.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat']) url.searchParams.delete(key);
  const pool = new pg.Pool({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: true },
    max: 3, connectionTimeoutMillis: 20000, idleTimeoutMillis: 10000, statement_timeout: 15000, keepAlive: true });
  pool.on('error', () => console.error('An idle PostgreSQL connection failed; it will be replaced.'));
  const makeStore = (client?: pg.PoolClient): Store => {
    const query = (sql: string, values: Value[] = []) => {
      let index = 0;
      return (client || pool).query(sql.replace(/\?/g, () => `$${++index}`), values);
    };
    return {
      dialect: 'postgres',
      prepare(sql) {
        return {
          get: async <T>(...values: Value[]) => (await query(sql, values)).rows[0] as T | undefined,
          all: async <T>(...values: Value[]) => (await query(sql, values)).rows as T[],
          run: async (...values) => { await query(sql, values); },
        };
      },
      exec: async sql => { await query(sql); },
      transaction: async work => {
        if (client) throw new Error('Nested transactions are not supported');
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          const result = await work(makeStore(connection));
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally { connection.release(); }
      },
      lockOrder(id) {
        if (!client) throw new Error('Order locks require a transaction');
        return this.prepare('SELECT * FROM orders WHERE id=? FOR UPDATE').get<OrderRow>(id);
      },
      close: () => pool.end(),
    };
  };
  const store = makeStore();
  try {
    await store.transaction(async tx => {
      await tx.exec('SELECT pg_advisory_xact_lock(818427001)');
      await tx.exec(postgresSchema);
    });
    return store;
  } catch (error) { await pool.end(); throw error; }
}
