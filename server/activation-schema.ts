export const activationSchema = `
  CREATE TABLE IF NOT EXISTS activation_key_check (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS activation_codes (
    id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, code_suffix TEXT NOT NULL,
    plan_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','redeemed','disabled')),
    is_demo INTEGER NOT NULL CHECK(is_demo IN (0,1)), source TEXT NOT NULL,
    expires_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activation_jobs (
    id TEXT PRIMARY KEY, code_id TEXT NOT NULL UNIQUE REFERENCES activation_codes(id),
    access_hash TEXT NOT NULL, account_email TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','processing','needs_session','needs_review','completed','failed')),
    session_ciphertext TEXT, session_expires_at TEXT,
    delivery_reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS activation_events (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES activation_jobs(id),
    kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activation_jobs_status ON activation_jobs(status,created_at);
  CREATE INDEX IF NOT EXISTS activation_events_job ON activation_events(job_id,created_at,id);
`;
