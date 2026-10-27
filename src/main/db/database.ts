import { DatabaseSync } from 'node:sqlite'

// Each entry upgrades the schema by one version; PRAGMA user_version tracks how many ran.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    website TEXT,
    description TEXT NOT NULL,
    signals TEXT NOT NULL,
    country TEXT,
    city TEXT,
    remote INTEGER,
    stage TEXT,
    emails TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    status TEXT NOT NULL,
    fit_score REAL NOT NULL,
    why_fit TEXT NOT NULL,
    contact TEXT,
    draft TEXT,
    follow_ups_sent INTEGER NOT NULL DEFAULT 0,
    next_action_at TEXT,
    needs_approval INTEGER NOT NULL DEFAULT 0,
    first_sent_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX leads_company ON leads(company_id);
  CREATE INDEX leads_status ON leads(status);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    in_reply_to TEXT,
    refs TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX messages_lead ON messages(lead_id);
  `
]

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return db
}
