import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  host_token  TEXT NOT NULL,
  guest_token TEXT,
  status      TEXT NOT NULL DEFAULT 'waiting',
  opening_message_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at   TEXT,
  closed_at   TEXT,
  close_reason TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  sender     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);

CREATE TABLE IF NOT EXISTS invites (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id                TEXT NOT NULL REFERENCES rooms(id),
  token_hash             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  claimed_at             TEXT,
  claim_idempotency_key  TEXT,
  claim_guest_token      TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_room_id ON invites(room_id);
`;

export function initializeSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const roomColumns = db
    .prepare(`PRAGMA table_info(rooms)`)
    .all() as Array<{ name: string }>;
  if (!roomColumns.some((column) => column.name === "opening_message_id")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN opening_message_id INTEGER;`);
  }
}
