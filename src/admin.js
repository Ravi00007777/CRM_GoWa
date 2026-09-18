const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const cfg = require('./config');
const gowa = require('./gowa');
const { toJid } = require('./redact');
const { dueDates } = require('./schedule');

const router = express.Router();

router.use((req, res, next) => {
  const got = Buffer.from(req.get('Authorization') || '');
  const want = Buffer.from(`Bearer ${cfg.adminToken}`);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.sendStatus(401);
  next();
});

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function required(body, ...keys) {
  for (const k of keys) if (body[k] === undefined || body[k] === '') fail(`${k} is required`);
}
function email(v) {
  if (v != null && !EMAIL_OK.test(v)) fail('invalid email');
  return v ?? null;
}

const handle = (status, fn) => (req, res) => {
  try {
    res.status(status).json(fn(req.body || {}, req));
  } catch (err) {
    const unique = String(err.code).startsWith('SQLITE_CONSTRAINT_UNIQUE');
    const clash = /\.tag\b/.test(err.message) ? 'that tag is already used by this teacher' : 'phone number is already used';
    res.status(err.status || (unique ? 409 : 400)).json({ error: unique ? clash : err.message });
  }
};

// Tags are typed by teachers/parents as #tag, so keep them short, lowercase and clear of the keywords.
function tag(v, name) {
  const t = String(v || String(name).split(/\s+/)[0]).toLowerCase().replace(/^#/, '');
  if (!/^[a-z0-9_-]{1,20}$/.test(t)) fail('tag must be 1-20 letters, digits, - or _');
  if (['result', 'list'].includes(t)) fail(`#${t} is a reserved word; pick another tag`);
  return t;
}

// A tag must be unique among a teacher's students and among a parent's children, or #tag becomes ambiguous.
function checkTag(s) {
  const clash = db.prepare(`SELECT name FROM students WHERE id IS NOT ? AND tag = ?
    AND ((? IS NOT NULL AND teacher_id = ?) OR parent_id = ?)`).get(s.id ?? null, s.tag, s.teacher_id, s.teacher_id, s.parent_id);
  if (clash) fail(`tag #${s.tag} is already used by ${clash.name} (same teacher or same parent)`, 409);
}

const teacherId = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (!db.prepare('SELECT 1 FROM teachers WHERE id = ?').get(v)) fail('teacher not found', 404);
  return Number(v);
};

router.get('/teachers', handle(200, () => db.prepare(`SELECT t.*,
  (SELECT COUNT(*) FROM students s WHERE s.teacher_id = t.id) AS students FROM teachers t ORDER BY t.name`).all()));

router.post('/teachers', handle(201, (b) => {
  required(b, 'name', 'phone');
  const row = { name: b.name, wa_jid: toJid(b.phone, cfg.countryCode), payout_email: email(b.payout_email) };
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO teachers (name, wa_jid, payout_email) VALUES (@name, @wa_jid, @payout_email)').run(row);
  return { id: lastInsertRowid, ...row };
}));

const STUDENTS = `SELECT s.*, p.wa_jid AS parent_wa_jid, p.name AS parent_name, p.payment_email AS parent_payment_email,
  t.name AS teacher FROM students s JOIN parents p ON p.id = s.parent_id LEFT JOIN teachers t ON t.id = s.teacher_id`;
const student = (id) => db.prepare(`${STUDENTS} WHERE s.id = ?`).get(id) || fail('student not found', 404);

router.get('/students', handle(200, () => db.prepare(`${STUDENTS} ORDER BY s.name`).all()));

// Siblings share a parent: the parent is found by phone, or created.
router.post('/students', handle(201, (b) => {
  required(b, 'name', 'parent_phone');
  const jid = toJid(b.parent_phone, cfg.countryCode);
  return db.transaction(() => {
    let parent = db.prepare('SELECT id FROM parents WHERE wa_jid = ?').get(jid);
    if (!parent) {
      parent = { id: db.prepare('INSERT INTO parents (name, wa_jid, payment_email) VALUES (?, ?, ?)')
        .run(b.parent_name || null, jid, email(b.parent_payment_email || null)).lastInsertRowid };
    }
    const s = { name: b.name, tag: tag(b.tag, b.name), parent_id: parent.id, teacher_id: teacherId(b.teacher_id), grade: b.grade ?? null };
    checkTag(s);
    const { lastInsertRowid } = db.prepare(`INSERT INTO students (name, tag, parent_id, teacher_id, grade)
      VALUES (@name, @tag, @parent_id, @teacher_id, @grade)`).run(s);
    return student(lastInsertRowid);
  })();
}));

// Assign/switch teacher (teacher_id), end the assignment (teacher_id: null), or edit tag/grade.
// Old classes and messages keep their teacher_id, so history survives a switch.
router.patch('/students/:id', handle(200, (b, req) => {
  const s = { ...student(req.params.id) };
  const oldTeacher = s.teacher_id;
  if ('teacher_id' in b) s.teacher_id = teacherId(b.teacher_id);
  if ('tag' in b) s.tag = tag(b.tag, s.name);
  if ('grade' in b) s.grade = b.grade || null;
  checkTag(s);
  db.prepare('UPDATE students SET teacher_id = @teacher_id, tag = @tag, grade = @grade WHERE id = @id').run(s);
  if (oldTeacher && s.teacher_id !== oldTeacher) flagOrphans(s, oldTeacher);
  return student(s.id);
}));

// After a switch the old teacher can neither be reminded (reminders skip them) nor deliver (the relay
// refuses an ended assignment), so anything already overdue would go missing. Flag it for the admin instead.
const orphans = db.prepare(`UPDATE classes SET needs_followup = 1 WHERE student_id = ? AND teacher_id = ?
  AND ((notes_due_at <= ? AND notes_sent_at IS NULL) OR (test_result_due_at <= ? AND test_result_sent_at IS NULL))`);
function flagOrphans(s, oldTeacher) {
  const now = new Date().toISOString();
  const { changes } = orphans.run(s.id, oldTeacher, now, now);
  if (!changes) return;
  const was = db.prepare('SELECT name FROM teachers WHERE id = ?').get(oldTeacher);
  gowa.alertAdmin(`${s.name} moved off teacher ${was.name}: ${changes} class(es) still owe notes or a test result. `
    + 'Marked needs_followup.').catch((err) => console.error('[admin] orphan alert failed:', err.message));
}

router.get('/students/:id/messages', handle(200, (_b, req) => db.prepare(`SELECT m.*, t.name AS teacher
  FROM messages m JOIN teachers t ON t.id = m.teacher_id WHERE m.student_id = ? ORDER BY m.sent_at`).all(req.params.id)));

// A class is always with the student's current teacher.
router.post('/classes', handle(201, (b) => {
  required(b, 'student_id', 'held_at');
  const s = student(b.student_id);
  if (!s.teacher_id) fail(`${s.name} has no teacher assigned`);
  const row = { teacher_id: s.teacher_id, student_id: s.id, meet_link: b.meet_link || null,
    ...dueDates(b.held_at, cfg.notesSlaHours, cfg.testHourIst) };
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO classes (teacher_id, student_id, held_at, meet_link, notes_due_at, test_result_due_at)
    VALUES (@teacher_id, @student_id, @held_at, @meet_link, @notes_due_at, @test_result_due_at)`).run(row);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(lastInsertRowid);
}));

const CLASSES = `SELECT c.*, t.name AS teacher, s.name AS student, s.tag FROM classes c
  JOIN teachers t ON t.id = c.teacher_id JOIN students s ON s.id = c.student_id`;
router.get('/classes', handle(200, (_b, req) => req.query.needs_followup === '1'
  ? db.prepare(`${CLASSES} WHERE c.needs_followup = 1 ORDER BY c.held_at DESC`).all()
  : db.prepare(`${CLASSES} ORDER BY c.held_at DESC LIMIT 200`).all()));

const PATCHABLE = ['notes_sent_at', 'test_result_sent_at', 'needs_followup', 'meet_link'];
router.patch('/classes/:id', handle(200, (b, req) => {
  const keys = Object.keys(b).filter((k) => PATCHABLE.includes(k));
  if (!keys.length) fail(`nothing to update; allowed: ${PATCHABLE.join(', ')}`);
  const { changes } = db.prepare(`UPDATE classes SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...Object.fromEntries(keys.map((k) => [k, b[k]])), id: req.params.id });
  if (!changes) fail('class not found', 404);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
}));

module.exports = router;
