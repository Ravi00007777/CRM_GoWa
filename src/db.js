const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { dbPath } = require('./config');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// All timestamps are ISO-8601 UTC strings (Date#toISOString), so string comparison == time comparison.
db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  wa_jid TEXT NOT NULL UNIQUE,
  payout_email TEXT
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_wa_jid TEXT NOT NULL UNIQUE,
  parent_payment_email TEXT,
  grade TEXT
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  held_at TEXT NOT NULL,
  meet_link TEXT,
  notes_due_at TEXT,
  notes_sent_at TEXT,
  test_result_due_at TEXT,
  test_result_sent_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  -- separate counter so notes reminders don't use up the test-result reminders
  test_reminder_count INTEGER NOT NULL DEFAULT 0,
  needs_followup INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS classes_teacher ON classes(teacher_id, held_at);
CREATE INDEX IF NOT EXISTS classes_student ON classes(student_id, held_at);
-- Audit log. content is ALWAYS the redacted text, never raw.
-- wa_message_id is the inbound id; UNIQUE makes gowa webhook retries idempotent.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  class_id INTEGER REFERENCES classes(id),
  direction TEXT NOT NULL CHECK (direction IN ('teacher_to_student', 'student_to_teacher')),
  wa_message_id TEXT UNIQUE,
  content TEXT,
  status TEXT NOT NULL CHECK (status IN ('relayed', 'flagged', 'dropped')),
  sent_at TEXT NOT NULL
);
`);

module.exports = db;
