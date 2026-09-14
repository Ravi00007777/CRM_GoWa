const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const cfg = require('./config');
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
    const code = err.status || (String(err.code).startsWith('SQLITE_CONSTRAINT_UNIQUE') ? 409 : 400);
    res.status(code).json({ error: err.message });
  }
};

router.post('/teachers', handle(201, (b) => {
  required(b, 'name', 'phone');
  const row = { name: b.name, wa_jid: toJid(b.phone, cfg.countryCode), payout_email: email(b.payout_email) };
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO teachers (name, wa_jid, payout_email) VALUES (@name, @wa_jid, @payout_email)').run(row);
  return { id: lastInsertRowid, ...row };
}));

router.post('/students', handle(201, (b) => {
  required(b, 'name', 'parent_phone');
  const row = {
    name: b.name,
    parent_wa_jid: toJid(b.parent_phone, cfg.countryCode),
    parent_payment_email: email(b.parent_payment_email),
    grade: b.grade ?? null,
  };
  const { lastInsertRowid } = db.prepare(`INSERT INTO students (name, parent_wa_jid, parent_payment_email, grade)
    VALUES (@name, @parent_wa_jid, @parent_payment_email, @grade)`).run(row);
  return { id: lastInsertRowid, ...row };
}));

router.post('/classes', handle(201, (b) => {
  required(b, 'teacher_id', 'student_id', 'held_at');
  const row = {
    teacher_id: b.teacher_id,
    student_id: b.student_id,
    meet_link: b.meet_link ?? null,
    ...dueDates(b.held_at, cfg.notesSlaHours, cfg.testHourIst),
  };
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO classes (teacher_id, student_id, held_at, meet_link, notes_due_at, test_result_due_at)
    VALUES (@teacher_id, @student_id, @held_at, @meet_link, @notes_due_at, @test_result_due_at)`).run(row);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(lastInsertRowid);
}));

router.get('/classes', handle(200, (_b, req) => req.query.needs_followup === '1'
  ? db.prepare('SELECT * FROM classes WHERE needs_followup = 1 ORDER BY held_at DESC').all()
  : db.prepare('SELECT * FROM classes ORDER BY held_at DESC LIMIT 200').all()));

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
