const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { dbPath } = require('./config');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// v1 schema had the parent phone on students and no teacher assignment. Rebuild only while it holds no students.
const oldStudents = db.prepare("SELECT 1 FROM pragma_table_info('students') WHERE name = 'parent_wa_jid'").get();
if (oldStudents) {
  if (db.prepare('SELECT COUNT(*) AS n FROM students').get().n) {
    throw new Error('Old students table has rows; migrate them to parents/students by hand before starting');
  }
  db.exec('DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS classes; DROP TABLE students;');
}

// All timestamps are ISO-8601 UTC strings (Date#toISOString), so string comparison == time comparison.
db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  wa_jid TEXT NOT NULL UNIQUE,
  payout_email TEXT
);
CREATE TABLE IF NOT EXISTS parents (
  id INTEGER PRIMARY KEY,
  name TEXT,
  wa_jid TEXT NOT NULL UNIQUE,
  payment_email TEXT
);
-- A student has at most one teacher at a time (teacher_id NULL = not assigned).
-- tag is how a teacher with several students, or a parent with several children, addresses this student: #tag.
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  teacher_id INTEGER REFERENCES teachers(id),
  grade TEXT,
  UNIQUE (parent_id, tag)
);
CREATE INDEX IF NOT EXISTS students_teacher ON students(teacher_id);
-- route() resolves a teacher's #tag by tag alone, so a duplicate would silently misroute to the wrong parent.
CREATE UNIQUE INDEX IF NOT EXISTS students_teacher_tag ON students(teacher_id, tag) WHERE teacher_id IS NOT NULL;
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
CREATE INDEX IF NOT EXISTS classes_pair ON classes(teacher_id, student_id, held_at);
-- Audit log. content is ALWAYS the redacted text, never raw.
-- wa_message_id is the inbound id; UNIQUE makes gowa webhook retries idempotent.
-- out_message_id is the relayed copy's id, so a swipe-reply to either copy finds this conversation.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  class_id INTEGER REFERENCES classes(id),
  direction TEXT NOT NULL CHECK (direction IN ('teacher_to_student', 'student_to_teacher')),
  wa_message_id TEXT UNIQUE,
  out_message_id TEXT,
  content TEXT,
  status TEXT NOT NULL CHECK (status IN ('relayed', 'flagged', 'dropped')),
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(teacher_id, student_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_out ON messages(out_message_id);
`);

// Rows that history points at are archived instead of deleted, so classes and the message log
// keep their teacher and student. Archived rows are hidden from the dashboard and the relay.
for (const t of ['teachers', 'students']) {
  const has = db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = 'archived_at'`).get();
  if (!has) db.exec(`ALTER TABLE ${t} ADD COLUMN archived_at TEXT`);
}

module.exports = db;
